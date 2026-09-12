# esuyo-opencode-tks — Fork + Extend Plan

Date: 2026-09-11
Source: `https://github.com/Tarquinen/oc-tps` (`oc-tps@0.0.10`)
Target: `/workspace/esuyo-opencode-tks/` — single source of truth (container uses `/workspace/...`, not `/workspaces/...`). ALL deliverables — `tui.tsx`, `package.json`, `README.md`, `assets/`, `.github/`, `tsconfig.json`, `LICENSE`, `NOTICE` — are written directly into this directory. No source, config, or build output is written outside it; the only exception is a throwaway upstream clone under `/tmp`, which is deleted after import.
Output: own npm package under own account, no upstream PR wait.

## 1. Goal

Create `esuyo-opencode-tks` — an owned fork of `oc-tps` that:

1. Keeps existing behaviour: live TPS / AVG TPS / AVG TTFT in `session_prompt_right`.
2. Adds **GAP metric**: time between end of last assistant response and start of next response, per session.
3. Adds **file logging**: append per-message + per-session stats as JSONL for later analysis.
4. Publishes under own npm account as scoped package, installable via `opencode plugin`.

Non-goals (v1):
- No dashboard UI, no cloud upload, no prompt-content logging.
- No upstream PR; upstream is reference only.

## 2. Background / Analysis (verified 2026-09-11)

- Repo: 4 files — `tui.tsx` (309 lines), `package.json`, `README.md`, `assets/demo.gif`.
- `package.json`: no `scripts`/`postinstall`, `files: [assets/, README.md, tui.tsx]`, deps `@opentui/core`, `@opentui/solid`, `solid-js`. Clean.
- `tui.tsx`: subscribes to `message.part.delta`, `message.updated`, `message.part.updated`; reads `api.state.session.status()`, `api.state.part()`; computes `estimateStreamTokens = ceil(bytes/5)`, `activeDurationMs`, session averages. Renders `<text>TPS x | AVG y | TTFT z</text>`. No `fetch/fs/child_process/env/eval`.
- Publish workflow `.github/workflows/publish.yml`: `contents:read + id-token:write`, `npm publish --provenance`. Good hygiene.
- npm: `oc-tps@0.0.10`, ~265 weekly downloads, 8 versions, license: none declared.
- Risk model: TUI plugins run in-process with full Node rights (no sandbox). Current code benign; future updates must be reviewed. Pin versions.

## 3. Decision: hard-fork copy (not fresh, not PR)

- **Not PR**: user explicitly does not want to wait on maintainer.
- **Not fresh**: rewriting reproduces the same 300 lines (slot registration, tracker, Solid component). No benefit.
- **Hard-fork copy**: `git clone`, `git remote remove origin`, new repo + new npm name, preserve attribution in README/CHANGELOG. Keeps ability to `git cherry-pick` upstream fixes.

## 4. Naming / Packaging

npm name `oc-tps` is taken by `tarquinen`. Must rename.

- Decided: npm `name` `@esuyo/esuyo-opencode-tks` (scoped), plugin `id` / repo `esuyo-opencode-tks`.
- `package.json` changes:
  ```json
  {
    "name": "@esuyo/esuyo-opencode-tks",
    "version": "0.1.0",
    "repository": { "type": "git", "url": "https://github.com/8perezm/esuyo-opencode-tks" },
    "author": "8perezm (https://github.com/8perezm)",
    "license": "MIT",
    "type": "module",
    "exports": { "./tui": { "import": "./tui.tsx" } },
    "engines": { "opencode": ">=1.3.14" }
  }
  ```
- `tui.tsx:304-307`: `id: "oc-tps"` → `id: "esuyo-opencode-tks"`.
- Keep `files`, `dependencies` as-is unless bump needed for opencode compat.
- Add `LICENSE` (MIT) + `NOTICE`: "Derived from Tarquinen/oc-tps @ 89bf5b8, MIT-compatible, link back".
- Upstream has no declared license — keep attribution prominent, do not publish as `oc-tps`.

## 5. Feature A — GAP metric (inter-response time)

Definition (v1): `GAP = nextAssistant.time.created - prevAssistant.time.completed` per `sessionID`. Includes user think-time + queueing. Display `-` on first message.

Optional v1.1: `MODEL_IDLE = next.firstResponseAt - prev.lastTokenAt` (excludes user time). Track both, display GAP, log both.

### Data model changes (`tui.tsx:30-34`)

```ts
type TrackerState = {
  streamSamplesBySession: Record<string, StreamSample[]>
  messageTimingByID: Record<string, MessageTiming>
  sessionAverageByID: Record<string, SessionAverage>
  lastCompletedAtBySession: Record<string, number>  // NEW
  lastGapMsBySession: Record<string, number>        // NEW
}
```

Init both as `{}` in `tui()` (`tui.tsx:139-143`).

### Logic changes (`onMessage`, `tui.tsx:203-248`)

- On start (`!info.time.completed`, `role === "assistant"`):
  ```ts
  const prev = tracker.lastCompletedAtBySession[sessionID]
  if (typeof prev === "number") {
    tracker.lastGapMsBySession[sessionID] = Math.max(info.time.created - prev, 0)
  }
  ```
- On complete (`info.time.completed`):
  ```ts
  tracker.lastCompletedAtBySession[sessionID] = info.time.completed
  ```
  Place after existing average-accumulation block, before `delete tracker.messageTimingByID[...]`.
- Edge cases:
  - `finish === "tool-calls"` intermediate completes: do NOT overwrite `lastCompletedAt` with tool-chunk time; only final message completion (check `info.finish !== "tool-calls"` or use existing `timing.lastToolCallAt` logic). Decide: GAP measured between final completions only.
  - Clock skew / out-of-order: clamp `>= 0`.
  - Session switch: keyed by `sessionID`, no cross-talk.
  - `pruneSamples` unchanged.

### UI changes (`SessionPromptRight`, `tui.tsx:73-136`)

```ts
function lastGap() {
  const ms = props.tracker.lastGapMsBySession[props.sessionID]
  if (typeof ms !== "number" || ms < 0) return undefined
  return ms >= 10000 ? `${(ms/1000).toFixed(0)}s` : `${(ms/1000).toFixed(1)}s`
}
function statusText() {
  const live = liveTps() ?? "-"
  const avg = sessionAverage() ?? "-"
  const ttft = sessionTtft() ?? "-"
  const gap = lastGap() ?? "-"
  return `TPS ${live} | AVG ${avg} | TTFT ${ttft} | GAP ${gap}`
}
```

Keep width small; TUI right slot truncates on narrow terminals.

## 6. Feature B — File logging (JSONL)

### Requirements
- Append-only, non-blocking, never crash TUI on I/O error.
- Log metadata only: no prompt/response text. `delta` length already aggregated; do not log `delta` strings.
- Default path: `~/.local/share/opencode/esuyo-opencode-tks.log` (XDG-ish). Override via env `ESUYO_TPS_LOG`.
- One JSON object per line. Rotate externally (user `logrotate`); v1 does not implement rotation, caps line size.

### Schema (v1)

```jsonc
{
  "v": 1,
  "at": "2026-09-11T23:50:00.000Z",   // completion wall-time
  "sessionID": "...",
  "messageID": "...",
  "finish": "stop | tool-calls | ...",
  "tokensOutput": 123, "tokensReasoning": 45, "tokensTotal": 168,
  "durationMs": 2345,                 // firstResponseAt -> endAt (existing logic)
  "ttftMs": 456,                      // requestStartAt -> firstResponseAt
  "gapMs": 12340,                     // prev completed -> this created (nullable first msg)
  "avgTps": 71.6,                     // tokensTotal / duration
  "liveSamplesDropped": false
}
```

Also log session summary on each completion (optional second line with `type: "session"` + cumulative `sessionAverageByID[sessionID]`). Keep v1 to per-message lines only to limit scope; add session lines in v1.1 if needed.

### Implementation

```ts
import { appendFile, mkdir } from "node:fs/promises"
import { join, dirname } from "node:path"
import { homedir } from "node:os"

const LOG_PATH = process.env.ESUYO_TPS_LOG
  ?? join(homedir(), ".local/share/opencode", "esuyo-opencode-tks.log");

await mkdir(dirname(LOG_PATH), { recursive: true }); // once in tui() init

async function logLine(obj: unknown) {
  try {
    await appendFile(LOG_PATH, JSON.stringify(obj) + "\n", "utf8");
  } catch { /* swallow: never break TUI */ }
}
```

Call `void logLine({...})` (no await on hot path) at the same site where `sessionAverageByID` is updated. Guard `totalTokens > 0 && durationMs`.

Tests: mock `appendFile` or set `ESUYO_TPS_LOG` to tmp file, emit fake `message.updated` events, assert JSONL parses.

## 7. Build / Repo Steps (ordered)

1. Scaffold in place at `/workspace/esuyo-opencode-tks` (this dir already exists and contains `docs/`). Clone upstream only to `/tmp`, copy the upstream deliverables into the target root, then delete the temp clone so no code lives outside the target:
   ```bash
   git clone --depth 1 https://github.com/Tarquinen/oc-tps /tmp/oc-tps-src
   cp -r /tmp/oc-tps-src/{tui.tsx,package.json,README.md,assets,.github} /workspace/esuyo-opencode-tks/
   rm -rf /tmp/oc-tps-src
   cd /workspace/esuyo-opencode-tks && git init && git add -A && git commit -m "chore: import oc-tps@0.0.10 as base"
   gh repo create esuyo-opencode-tks --public --source=. --push
   ```
   All later work (rename, GAP, logging, `tsconfig.json`, `LICENSE`/`NOTICE`, README) also happens inside `/workspace/esuyo-opencode-tks`. Never use a sibling `-src` directory; never write code anywhere else on the filesystem.
2. Rename package + id + LICENSE/NOTICE (Sec. 4). `npm install` to verify deps resolve.
3. Implement GAP (Sec. 5). `npx tsc --noEmit` (add minimal `tsconfig.json` if missing: `jsxImportSource @opentui/solid`, `module nodenext`).
4. Implement logging (Sec. 6) behind env override.
5. Update README: install `opencode plugin @esuyo/esuyo-opencode-tks@latest --global`, demo of `GAP`, log path + schema + `ESUYO_TPS_LOG`, attribution to upstream.
6. Publish: `npm publish --access public --provenance`. Verify `npm view @esuyo/esuyo-opencode-tks version dist.tarball`.
7. Install smoke: `opencode plugin @esuyo/esuyo-opencode-tks@latest --global`, restart opencode, confirm right-slot shows `TPS … | AVG … | TTFT … | GAP …`, send 2 messages, confirm GAP populates on 2nd, `tail $LOG` shows 2 JSONL lines.
8. Copy `publish.yml` from upstream (already has provenance); set npm trusted publishing for new package name.

## 8. Validation (cheapest first)

1. `npx tsc --noEmit` — types.
2. Manual TUI smoke via `npm run server:sandbox`-equivalent or real `opencode` + `opencode plugin` install (no full e2e; per AGENTS.md e2e policy, never run full suite).
3. Log checks: `node -e "require('fs').readFileSync(process.env.HOME+'/.local/share/opencode/esuyo-opencode-tks.log','utf8').split('\n').filter(Boolean).forEach(l=>JSON.parse(l))"` — all lines parse.
4. Width check: 80-col terminal, no truncation of prompt.

## 9. Risks / Decisions

- **License**: upstream `license: none`. Mitigation: attribution + MIT on new code, link upstream commit hash, replace if upstream adds license.
- **npm name**: decided `@esuyo/esuyo-opencode-tks` (scoped). Old `oc-tps` must be uninstalled to avoid double slot registration.
- **Tool-call chunks**: GAP defined on final completions; document this.
- **Log growth**: no rotation v1; document `logrotate` snippet + `ESUYO_TPS_LOG=/dev/null` kill-switch.
- **Upstream drift**: watch `Tarquinen/oc-tps` releases monthly; cherry-pick.

## 10. Effort

- Import + rename + publish: 0.5h
- GAP: 1h + 0.5h smoke
- Logging: 1h + 0.5h tests
- Docs/release: 0.5h
- Total: ~4h for v1.

## 11. Open questions (default in parens)

- Package name decided: `@esuyo/esuyo-opencode-tks` (scoped), id/repo `esuyo-opencode-tks`.
- Log per-message only, or also per-session summary lines? (Per-message v1.)
- GAP format seconds with 1 decimal vs ms? (Seconds, 1 decimal under 10s, 0 decimals above.)
