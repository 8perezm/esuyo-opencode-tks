import assert from "node:assert/strict"
import { readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const LOG = join(tmpdir(), `esuyo-opencode-tks-test-${process.pid}.log`)
process.env.ESUYO_TPS_LOG = LOG
rmSync(LOG, { force: true })

const handlers = {}
let dispose = () => {}
const api = {
  event: {
    on: (name, cb) => {
      handlers[name] = cb
      return () => {}
    },
  },
  state: {
    session: { status: () => ({ type: "idle" }) },
    part: () => [{ id: "p1", type: "text" }],
  },
  slots: { register: () => {} },
  lifecycle: { onDispose: (fn) => (dispose = fn) },
  renderer: { requestRender: () => {} },
  theme: { current: { textMuted: "#ffffff" } },
}

const mod = await import(new URL("../.test-build/tui.js", import.meta.url).href)
await mod.default.tui(api)

const delta = (sessionID, messageID) =>
  handlers["message.part.delta"]({
    properties: { sessionID, messageID, partID: "p1", field: "text", delta: "hello world" },
  })

const start = (sessionID, id, created) =>
  handlers["message.updated"]({
    properties: {
      sessionID,
      info: { role: "assistant", sessionID, id, time: { created }, tokens: { output: 0, reasoning: 0 } },
    },
  })

const complete = (sessionID, id, created, completed, output, reasoning, finish = "stop") =>
  handlers["message.updated"]({
    properties: {
      sessionID,
      info: {
        role: "assistant",
        sessionID,
        id,
        finish,
        time: { created, completed },
        tokens: { output, reasoning },
      },
    },
  })

const toolRunning = (sessionID, messageID, startAt) =>
  handlers["message.part.updated"]({
    properties: {
      part: {
        type: "tool",
        sessionID,
        messageID,
        state: { status: "running", time: { start: startAt } },
      },
      time: startAt,
    },
  })

start("s1", "m1", 1000)
delta("s1", "m1")
complete("s1", "m1", 1000, 5000, 100, 20)

start("s1", "m2", 20000)
delta("s1", "m2")
complete("s1", "m2", 20000, 26000, 80, 10)

start("s1", "m3", 27000)
delta("s1", "m3")
toolRunning("s1", "m3", 29000)
complete("s1", "m3", 27000, 30000, 40, 5, "tool-calls")

start("s1", "m4", 35000)
delta("s1", "m4")
complete("s1", "m4", 35000, 40000, 60, 0)

start("s2", "m5", 100000)
delta("s2", "m5")
complete("s2", "m5", 100000, 105000, 50, 0)

handlers["message.updated"]({
  properties: { sessionID: "s1", info: { role: "user", sessionID: "s1", id: "u1", time: { created: 41000 } } },
})

await new Promise((resolve) => setTimeout(resolve, 200))
dispose()

const parsed = readFileSync(LOG, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))

const byID = Object.fromEntries(parsed.map((entry) => [entry.messageID, entry]))

assert.equal(parsed.length, 5, "one JSONL line per assistant completion")
assert.equal(byID.m1.gapMs, null, "first message has no gap")
assert.equal(byID.m2.gapMs, 15000, "gap between final completions")
assert.equal(byID.m3.gapMs, 1000, "gap tracked across tool-call message")
assert.equal(byID.m4.gapMs, 9000, "tool-calls completion does not reset last completion")
assert.equal(byID.m5.gapMs, null, "sessions do not leak gap state")
assert.equal(byID.m1.v, 1, "schema version")
assert.equal(byID.m1.tokensTotal, 120, "output + reasoning tokens")
assert.equal(typeof byID.m1.avgTps, "number", "avgTps is numeric")
assert.equal(byID.m1.liveSamplesDropped, false, "liveSamplesDropped present")
assert.equal(byID.m3.liveSamplesDropped, true, "tool call marks live samples dropped")
assert.equal(byID.m4.finish, "stop", "finish recorded")
assert.equal(byID.m5.sessionID, "s2", "session id recorded")

rmSync(LOG, { force: true })
console.log(`ok - ${parsed.length} JSONL records validated`)
