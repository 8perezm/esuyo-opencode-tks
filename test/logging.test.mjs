import assert from "node:assert/strict"
import { readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const LOG = join(tmpdir(), `esuyo-opencode-tks-test-${process.pid}.log`)
process.env.ESUYO_TPS_LOG = LOG
rmSync(LOG, { force: true })

const handlers = {}
const context = {
  options: {},
  data: {
    on: (name, cb) => {
      handlers[name] = cb
      return () => {}
    },
    session: { status: () => "idle" },
  },
  ui: { slot: () => () => {} },
  theme: { text: { base: "#ffffff", muted: "#ffffff" } },
  renderer: { requestRender: () => {} },
}

const mod = await import(new URL("../.test-build/tui.js", import.meta.url).href)

assert.equal(typeof mod.default, "object", "default export is a V2 plugin module")
assert.equal(typeof mod.default.id, "string", "plugin has an id")
assert.equal(typeof mod.default.setup, "function", "plugin has setup")

const cleanup = await mod.default.setup(context)

const step = (sessionID, id, created) =>
  handlers["session.step.started"]({
    created,
    data: { sessionID, assistantMessageID: id, agent: "build", model: {}, snapshot: "snap", started: created },
  })

const delta = (sessionID, id) =>
  handlers["session.text.delta"]({
    created: Date.now(),
    data: { sessionID, assistantMessageID: id, ordinal: 0, delta: "hello world" },
  })

const tool = (sessionID, id, created) =>
  handlers["session.tool.called"]({
    created,
    data: { sessionID, assistantMessageID: id, id: "call_1", input: {}, executed: true, state: {} },
  })

const end = (sessionID, id, created, output, reasoning, finish = "stop") =>
  handlers["session.step.ended"]({
    created,
    data: {
      sessionID,
      assistantMessageID: id,
      finish,
      rawFinish: finish,
      providerState: {},
      cost: 0,
      tokens: { input: 0, output, reasoning, cache: { read: 0, write: 0 } },
      snapshot: "snap",
      files: [],
    },
  })

step("s1", "m1", 1000)
delta("s1", "m1")
end("s1", "m1", 5000, 100, 20)

step("s1", "m2", 20000)
delta("s1", "m2")
end("s1", "m2", 26000, 80, 10)

step("s1", "m3", 27000)
delta("s1", "m3")
tool("s1", "m3", 29000)
end("s1", "m3", 30000, 40, 5, "tool-calls")

step("s1", "m4", 35000)
delta("s1", "m4")
end("s1", "m4", 40000, 60, 0)

step("s2", "m5", 100000)
delta("s2", "m5")
end("s2", "m5", 105000, 50, 0)

// Two steps of the same assistant message share one GAP.
step("s2", "m6", 110000)
delta("s2", "m6")
tool("s2", "m6", 112000)
end("s2", "m6", 113000, 10, 0, "tool-calls")
step("s2", "m6", 115000)
delta("s2", "m6")
end("s2", "m6", 118000, 20, 0)

handlers["session.execution.interrupted"]({ created: 120000, data: { sessionID: "s1", reason: "user" } })

await new Promise((resolve) => setTimeout(resolve, 200))
cleanup()

const parsed = readFileSync(LOG, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))

const byID = Object.fromEntries(parsed.map((entry) => [entry.messageID, entry]))

assert.equal(parsed.length, 7, "one JSONL line per completed step")
assert.equal(byID.m1.gapMs, null, "first message has no gap")
assert.equal(byID.m2.gapMs, 15000, "gap between final completions")
assert.equal(byID.m3.gapMs, 1000, "gap tracked across tool-call message")
assert.equal(byID.m4.gapMs, 9000, "tool-calls completion does not reset last completion")
assert.equal(byID.m5.gapMs, null, "sessions do not leak gap state")
assert.equal(byID.m6.gapMs, 5000, "later steps of one message reuse its gap")
assert.equal(byID.m1.v, 1, "schema version")
assert.equal(byID.m1.tokensTotal, 120, "output + reasoning tokens")
assert.equal(typeof byID.m1.avgTps, "number", "avgTps is numeric")
assert.equal(byID.m1.liveSamplesDropped, false, "liveSamplesDropped present")
assert.equal(byID.m3.liveSamplesDropped, true, "tool call marks live samples dropped")
assert.equal(byID.m4.finish, "stop", "finish recorded")
assert.equal(byID.m5.sessionID, "s2", "session id recorded")

rmSync(LOG, { force: true })
console.log(`ok - ${parsed.length} JSONL records validated`)
