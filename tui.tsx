/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { createSignal } from "solid-js"

type StreamSample = {
  at: number
  tokens: number
}

const STREAM_WINDOW_MS = 5_000
const LIVE_STALE_MS = 1_500
const SINGLE_SAMPLE_MS = 1_000

/** Timing of one model step. Keyed by the assistant message that owns it. */
type StepTiming = {
  sessionID: string
  requestStartAt: number
  firstResponseAt?: number
  lastTokenAt?: number
  lastToolCallAt?: number
}

type SessionAverage = {
  totalTokens: number
  totalDurationMs: number
  totalTtftMs: number
  stepCount: number
}

type TrackerState = {
  streamSamplesBySession: Record<string, StreamSample[]>
  timingByMessage: Record<string, StepTiming>
  openMessages: Record<string, boolean>
  sessionAverageByID: Record<string, SessionAverage>
  lastCompletedAtBySession: Record<string, number>
  lastGapMsBySession: Record<string, number>
  liveSamplesDroppedBySession: Record<string, boolean>
}

const LOG_PATH =
  process.env.ESUYO_TPS_LOG ?? join(homedir(), ".local/share/opencode", "esuyo-opencode-tks.log")

async function logLine(obj: unknown) {
  try {
    await appendFile(LOG_PATH, JSON.stringify(obj) + "\n", "utf8")
  } catch {}
}

function estimateStreamTokens(delta: string) {
  return Math.max(1, Math.ceil(Buffer.byteLength(delta, "utf8") / 5))
}

function formatRate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return undefined
  if (value >= 100) return `${Math.round(value)}`
  if (value >= 10) return `${value.toFixed(1)}`
  return `${value.toFixed(2)}`
}

function formatTtft(value: number) {
  if (!Number.isFinite(value) || value < 0) return undefined
  return `${value.toFixed(1)}s`
}

function activeDurationMs(samples: StreamSample[], tailAt?: number) {
  if (samples.length === 0) return 0
  if (samples.length === 1) {
    const tailDuration = tailAt ? Math.max(0, tailAt - samples[0].at) : SINGLE_SAMPLE_MS
    return Math.min(Math.max(tailDuration, 250), SINGLE_SAMPLE_MS)
  }

  let duration = 0
  for (let i = 1; i < samples.length; i++) {
    duration += Math.max(0, samples[i].at - samples[i - 1].at)
  }

  if (tailAt) {
    duration += Math.max(0, tailAt - samples[samples.length - 1].at)
  }

  return Math.max(duration, SINGLE_SAMPLE_MS)
}

const plugin: Plugin.Definition = Plugin.define({
  id: "esuyo-opencode-tks",
  async setup(context) {
    const tracker: TrackerState = {
      streamSamplesBySession: {},
      timingByMessage: {},
      openMessages: {},
      sessionAverageByID: {},
      lastCompletedAtBySession: {},
      lastGapMsBySession: {},
      liveSamplesDroppedBySession: {},
    }

    // Bumped on every tracker change so the slot re-renders.
    const [tick, bumpTick] = createSignal(0)
    const bump = () => bumpTick((value) => value + 1)

    try {
      await mkdir(dirname(LOG_PATH), { recursive: true })
    } catch {}

    const stamp = (event: { created: number }) =>
      Number.isFinite(event.created) ? event.created : Date.now()

    const pruneSamples = (now = Date.now()) => {
      let changed = false

      for (const [sessionID, samples] of Object.entries(tracker.streamSamplesBySession)) {
        const next = samples.filter((sample) => now - sample.at <= STREAM_WINDOW_MS)
        if (next.length !== samples.length) {
          changed = true
          if (next.length > 0) tracker.streamSamplesBySession[sessionID] = next
          else delete tracker.streamSamplesBySession[sessionID]
        }
      }

      if (changed) bump()
    }

    const clearLiveSamples = (sessionID: string) => {
      if (!tracker.streamSamplesBySession[sessionID]?.length) return
      delete tracker.streamSamplesBySession[sessionID]
      tracker.liveSamplesDroppedBySession[sessionID] = true
      bump()
    }

    const appendSample = (sessionID: string, messageID: string, sample: StreamSample) => {
      const now = sample.at
      tracker.streamSamplesBySession[sessionID] = [
        ...(tracker.streamSamplesBySession[sessionID] ?? []).filter(
          (item) => now - item.at <= STREAM_WINDOW_MS,
        ),
        sample,
      ]
      const timing = tracker.timingByMessage[messageID]
      if (timing) {
        tracker.timingByMessage[messageID] = timing.firstResponseAt
          ? { ...timing, lastTokenAt: now }
          : {
              ...timing,
              firstResponseAt: now,
              lastTokenAt: now,
            }
      }
      bump()
    }

    const dropSession = (sessionID: string) => {
      clearLiveSamples(sessionID)
      for (const [messageID, timing] of Object.entries(tracker.timingByMessage)) {
        if (timing.sessionID !== sessionID) continue
        delete tracker.timingByMessage[messageID]
        delete tracker.openMessages[messageID]
      }
      bump()
    }

    const stops: Array<() => void> = []

    const sampleDelta = (
      sessionID: string,
      messageID: string,
      delta: string,
    ) => {
      appendSample(sessionID, messageID, {
        at: Date.now(),
        tokens: estimateStreamTokens(delta),
      })
    }

    stops.push(
      context.data.on("session.text.delta", (event) =>
        sampleDelta(event.data.sessionID, event.data.assistantMessageID, event.data.delta),
      ),
    )

    stops.push(
      context.data.on("session.reasoning.delta", (event) =>
        sampleDelta(event.data.sessionID, event.data.assistantMessageID, event.data.delta),
      ),
    )

    stops.push(
      context.data.on("session.step.started", (event) => {
        const { sessionID, assistantMessageID } = event.data
        const now = stamp(event)

        // GAP is measured per assistant message, not per step, so only the
        // first step of a message opens a new one.
        if (!tracker.openMessages[assistantMessageID]) {
          tracker.openMessages[assistantMessageID] = true
          tracker.liveSamplesDroppedBySession[sessionID] = false
          const previous = tracker.lastCompletedAtBySession[sessionID]
          if (typeof previous === "number") {
            tracker.lastGapMsBySession[sessionID] = Math.max(now - previous, 0)
          }
        }

        tracker.timingByMessage[assistantMessageID] = { sessionID, requestStartAt: now }
        bump()
      }),
    )

    stops.push(
      context.data.on("session.step.ended", (event) => {
        const { sessionID, assistantMessageID, finish, tokens } = event.data
        const now = stamp(event)
        const timing = tracker.timingByMessage[assistantMessageID]
        delete tracker.timingByMessage[assistantMessageID]

        if (!timing) {
          bump()
          return
        }

        const totalTokens = tokens.output + tokens.reasoning
        if (typeof timing.firstResponseAt === "number" && totalTokens > 0) {
          const endAt = finish === "tool-calls" ? (timing.lastToolCallAt ?? now) : now
          const durationMs = Math.max(endAt - timing.firstResponseAt, 1)
          const ttftMs = Math.max(timing.firstResponseAt - timing.requestStartAt, 0)
          const totals = tracker.sessionAverageByID[sessionID] ?? {
            totalTokens: 0,
            totalDurationMs: 0,
            totalTtftMs: 0,
            stepCount: 0,
          }
          tracker.sessionAverageByID[sessionID] = {
            totalTokens: totals.totalTokens + totalTokens,
            totalDurationMs: totals.totalDurationMs + durationMs,
            totalTtftMs: totals.totalTtftMs + ttftMs,
            stepCount: totals.stepCount + 1,
          }
          void logLine({
            v: 1,
            at: new Date(now).toISOString(),
            sessionID,
            messageID: assistantMessageID,
            finish,
            tokensOutput: tokens.output,
            tokensReasoning: tokens.reasoning,
            tokensTotal: totalTokens,
            durationMs,
            ttftMs,
            gapMs: tracker.lastGapMsBySession[sessionID] ?? null,
            avgTps: Number((totalTokens / (durationMs / 1000)).toFixed(2)),
            liveSamplesDropped: tracker.liveSamplesDroppedBySession[sessionID] ?? false,
          })
        }

        // Intermediate tool-call steps do not reset the GAP baseline.
        if (finish !== "tool-calls") {
          tracker.lastCompletedAtBySession[sessionID] = now
          delete tracker.openMessages[assistantMessageID]
        }
        delete tracker.liveSamplesDroppedBySession[sessionID]
        pruneSamples(now)
        bump()
      }),
    )

    stops.push(
      context.data.on("session.step.failed", (event) => {
        delete tracker.timingByMessage[event.data.assistantMessageID]
        delete tracker.openMessages[event.data.assistantMessageID]
        bump()
      }),
    )

    stops.push(
      context.data.on("session.tool.called", (event) => {
        const { sessionID, assistantMessageID } = event.data
        const now = stamp(event)
        clearLiveSamples(sessionID)
        const timing = tracker.timingByMessage[assistantMessageID]
        if (!timing) return
        timing.firstResponseAt = timing.firstResponseAt ?? now
        timing.lastToolCallAt = now
        bump()
      }),
    )

    stops.push(context.data.on("session.execution.interrupted", (event) => dropSession(event.data.sessionID)))
    stops.push(context.data.on("session.execution.failed", (event) => dropSession(event.data.sessionID)))

    const timer = setInterval(() => {
      pruneSamples()
      bump()
    }, 1000)

    const sessionAverage = (sessionID: string) => {
      const totals = tracker.sessionAverageByID[sessionID]
      if (!totals || totals.totalTokens <= 0 || totals.totalDurationMs <= 0) return undefined
      return formatRate(totals.totalTokens / (totals.totalDurationMs / 1000))
    }

    const sessionTtft = (sessionID: string) => {
      const totals = tracker.sessionAverageByID[sessionID]
      if (!totals || totals.stepCount <= 0 || totals.totalTtftMs < 0) return undefined
      return formatTtft(totals.totalTtftMs / totals.stepCount / 1000)
    }

    const liveTps = (sessionID: string) => {
      if (context.data.session.status(sessionID) === "idle") return undefined
      const samples = tracker.streamSamplesBySession[sessionID] ?? []
      if (samples.length === 0) return undefined
      const now = Date.now()
      const relevant = samples.filter((sample) => now - sample.at <= STREAM_WINDOW_MS)
      if (relevant.length === 0) return undefined
      const lastSample = relevant[relevant.length - 1]
      if (!lastSample || now - lastSample.at > LIVE_STALE_MS) return undefined
      const total = relevant.reduce((sum, sample) => sum + sample.tokens, 0)
      const durationSeconds = activeDurationMs(relevant, now) / 1000
      if (durationSeconds <= 0) return undefined
      return formatRate(total / durationSeconds)
    }

    const lastGap = (sessionID: string) => {
      const ms = tracker.lastGapMsBySession[sessionID]
      if (typeof ms !== "number" || ms < 0) return undefined
      return ms >= 10000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)}s`
    }

    const statusText = (sessionID: string) => {
      // Reading the tick subscribes this text to tracker changes.
      tick()
      const live = liveTps(sessionID) ?? "-"
      const avg = sessionAverage(sessionID) ?? "-"
      const ttft = sessionTtft(sessionID) ?? "-"
      const gap = lastGap(sessionID) ?? "-"
      return `TPS ${live} | AVG ${avg} | TTFT ${ttft} | GAP ${gap}`
    }

    const unregister = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const sessionID = input.sessionID
        if (!sessionID) return null
        return <text fg={context.theme.text.muted}>{statusText(sessionID)}</text>
      },
    })

    return () => {
      unregister()
      clearInterval(timer)
      for (const stop of stops) stop()
    }
  },
})

export default plugin
