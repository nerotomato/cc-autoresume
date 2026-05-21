# cc-autoresume

[![English](https://img.shields.io/badge/lang-English-blue)](./README.md)
[![简体中文](https://img.shields.io/badge/lang-简体中文-lightgrey)](./README.zh-CN.md)

> A **command-line tool** that wraps Claude Code / Codex CLI in a PTY, automatically pauses when the subscription quota is about to hit the limit, and resumes the conversation right after the quota resets.

## 1. What is this

`cc-autoresume` is a **CLI tool** (installed as the `cc-autoresume` executable) — not a service, not a daemon, not a GUI. You run it the same way you run `claude` or `codex`, and it spawns the real CLI inside a PTY so the experience is indistinguishable from launching the target directly.

It solves the "stuck for hours because the **5h / 7d** subscription quota ran out" problem when using Claude Code (or the Codex CLI) for long sessions.

> ⚠️ **This tool does not replace Claude Code / Codex.** It *wraps* them. You must already have the underlying `claude` and/or `codex` CLI installed and working on your machine — see [Prerequisites](#4-prerequisites) below.

It sits between your terminal and the real `claude` / `codex` binary. By default it watches the wrapped CLI's output for rate-limit error messages and pauses the moment one is detected (**screen scan**, event-driven, works for any CLI).

When a pause is triggered, the wrapper makes **one on-demand call** to the Anthropic OAuth `usage` endpoint (if a token is available) to fetch the precise `resets_at`. That's the only network use by default — no periodic polling.

After the quota resets, the wrapper checks whether you've come back to the terminal — if yes, it stays silent; if no, it injects `ESC` + a resume hint + `Enter` so the original task continues.

Periodic API polling for preemptive pausing is still available as opt-in: set `CC_AUTORESUME_ENABLE_API_POLL=1`.

stdin, stdout, TTY resize, raw mode and signals are all passed through, so day-to-day usage feels identical to running the underlying CLI directly.

## 2. How it works

```
              ┌─────────────────────────────────────────────────┐
              │                  cc-autoresume                  │
              │                                                 │
   your TTY ──▶│   ┌─────────────────────────────────────────┐   │──▶ claude / codex
              │   │ Screen scanner (event-driven, default)  │   │   (inside node-pty)
              │   │   • matches rate-limit error patterns   │   │
              │   │   • tracks BUSY / IDLE state            │   │
              │   │   • on hit → call Anthropic API once    │   │
              │   │     to fetch precise resets_at           │   │
              │   └─────────────────────────────────────────┘   │
              │                  │ pause / wake                 │
              │       ESC + hint + Enter (only if user idle)    │
              └─────────────────────────────────────────────────┘
                      │
                      ▼
              ~/.cc-autoresume/{state-<pid>.json, log.jsonl}

   Opt-in: CC_AUTORESUME_ENABLE_API_POLL=1 also enables periodic
   utilization polling for preemptive pausing.
```

- **wrapper** (`src/wrapper.ts`) — spawns the target CLI via [`node-pty`](https://github.com/microsoft/node-pty) and bridges stdin/stdout/resize/SIGINT/SIGTERM. Pipes child output to both the terminal and the screen scanner.
- **screen-scanner** (`src/screen-scanner.ts`) — strips ANSI, maintains a rolling buffer, matches against the loaded trigger set, extracts reset times from error text, and runs a BUSY/IDLE state machine driven by spinner / cursor-hide markers.
- **triggers** (`src/triggers/`) — built-in pattern tables for `claude`, `codex` and a generic Chinese fallback (DeepSeek / Qwen / Doubao / GLM). Optionally merged with `~/.cc-autoresume/triggers.json`.
- **adapter** (`src/adapters/anthropic.ts`) — calls `https://api.anthropic.com/api/oauth/usage`. Used both for periodic polling and for one-shot reset-time fallback on screen triggers.
- **scheduler** (`src/scheduler.ts`) — owns the wake timer; verifies once before waking; if verify fails, pushes the wake another `defaultWaitHours` (default 5h) instead of giving up.
- **state-machine** (`src/state-machine.ts`) — picks wake time (text > API > default) and classifies pause vs. paused_long by `maxWaitHours`.

### When does the wrapper actually auto-resume?

|  Trigger source  |  BUSY at trigger?  | `auto_resume` | What happens on wake |
|---|---|---|---|
| Screen scan caught a rate-limit error | (implicitly yes) | `true` | Inject `ESC + hint + Enter` |
| API poll `utilization ≥ threshold`, scanner saw BUSY within last 5s | yes | `true` | Inject `ESC + hint + Enter` |
| API poll `utilization ≥ threshold`, scanner reports IDLE | no | `false` | Just clear state — don't inject anything |
| Any path, but at wake time the user is BUSY again | — | (overridden) | Skip injection — user already returned |

The "BUSY at wake" check protects against a foot-gun: if you stopped paying attention for 5h, the wrapper would auto-resume; if you came back early and started something else, the wrapper now stays out of your way.

### Polling cost — am I burning resources?

**Default mode (screen scan only)**: zero ambient cost. Screen scanning is event-driven on the PTY data stream — no timers, no polling, no network calls. The only network call is **at most one HTTPS GET per pause event** (to fetch `resets_at` from Anthropic's OAuth usage endpoint, if a token is available). Typical session: 0 API calls. Pause once: 1 API call. That's it.

**Opt-in: `CC_AUTORESUME_ENABLE_API_POLL=1`** adds periodic utilization polling for preemptive pausing. Cadence is adaptive based on highest current utilization:

| Highest utilization | Poll interval |
|---|---|
| `< 80%` | every **10 minutes** |
| `80% – 95%` | every **2 minutes** |
| `95% – 99%` | every **30 seconds** |
| `≥ 99%` (about to trip) | every **10 seconds** |
| Adapter error (transient / auth) | exponential backoff, capped at **5 min** |
| **While paused** | **no polling at all** — just one timer waiting for the reset |

There is no background daemon — every timer is torn down the moment you exit `cc-autoresume`.

> **Why is API polling off by default?** Screen scan already catches every rate-limit event instantly, and preemptive pausing has limited value (most users naturally stop near the limit anyway). Keeping the default minimal means Codex / Chinese-model users (and Anthropic users without a logged-in token) get a clean experience without auth errors in the log.

## 3. Outputs

| Path | Purpose | Override |
|---|---|---|
| `~/.cc-autoresume/state-<pid>.json` | Atomic snapshot (`version: 2`) of this wrapper's state including `trigger` (`5h`/`7d`/`both`/`screen`/`manual`), `auto_resume` flag, `wake_source` (`api`/`text`/`default`), wake time, PID | `CC_AUTORESUME_STATE_PATH` (switches back to explicit single-file mode) |
| `~/.cc-autoresume/log.jsonl` | Line-delimited JSON log of every event (`startup`, `snapshot`, `pause_due`, `screen_pause_due`, `wake_sent`, `wake_skipped_user_active`, `verify_pushed`, …) | `CC_AUTORESUME_LOG` |
| Stderr banner | Single-line notice on pause / wake / verify-pushed / low balance — keeps the wrapped CLI's stdout clean | — |

## 4. Prerequisites

Before installing `cc-autoresume`, make sure the following are in place:

| Requirement | Why |
|---|---|
| **Node.js ≥ 20** | The wrapper itself runs on Node 20+; `node-pty` prebuilt binaries target this range. |
| **`claude` and/or `codex` CLI already installed** | This tool *wraps* them — it does not bundle or replace them. Verify with `which claude` / `which codex`. Install Claude Code from [claude.com/claude-code](https://www.claude.com/claude-code). |
| **A logged-in Claude Code session** *(only for API polling path)* | `cc-autoresume` reads the OAuth token from `~/.claude/.credentials.json` (the file Claude Code writes after `claude login`). Alternatively export `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`. Skip if you only want screen scan (Codex / Chinese models / no-token setups). |
| **An active Claude subscription** *(only for API polling path)* | The `usage` endpoint only returns 5h / 7d windows for subscription accounts. Codex / Chinese models work fine via screen scan without this. |

If `claude` is not on your `PATH`, `cc-autoresume --target=claude` will fail with `command not found` — fix the underlying CLI installation first.

## 5. Installation

### Option A — install from the npm registry (recommended)

```bash
npm install -g cc-autoresume
cc-autoresume --target=claude -- --help
```

> A `postinstall` script fixes the executable bit on `node-pty`'s `spawn-helper` (works around EACCES on some macOS / Linux setups).

### Option B — install from GitHub source

```bash
git clone https://github.com/nerotomato/cc-autoresume.git
cd cc-autoresume
npm install
npm run build

# Run the local bin
./bin/cc-autoresume --target=claude

# Or symlink it onto your PATH
npm link
cc-autoresume --target=claude
```

## 6. Usage

Replace whatever command normally starts `claude` / `codex`:

```bash
# auto-detect (prefers claude, falls back to codex)
cc-autoresume

# pick a target explicitly
cc-autoresume --target=claude
cc-autoresume --target=codex

# pass arguments through to the target CLI (after --)
cc-autoresume --target=claude -- --resume
cc-autoresume --target=claude -- "summarize this repo"
```

| Flag | Meaning |
|---|---|
| `--target=auto\|claude\|codex` | Which CLI to wrap. `auto` prefers `claude`, then `codex` |
| any other flag | Anything cc-autoresume doesn't recognize is forwarded to the target CLI — `cc-autoresume --target=claude --allow-dangerously-skip-permissions` works directly |
| `-- <args...>` | Optional explicit separator. Everything after `--` is forwarded verbatim (useful when a value looks like a wrapper flag, e.g. `-- --target=foo`) |

## 7. Configuration (env vars)

| Variable | Default | Description |
|---|---|---|
| `CC_AUTORESUME_TARGET` | `auto` | Same as `--target` |
| `CC_AUTORESUME_THRESHOLD` | `99` | Pause when API utilization reaches this percentage (API polling path only) |
| `CC_AUTORESUME_MAX_WAIT_HOURS` | `12` | If wait would exceed this, enter `paused_long` (banner only, no auto-wake) |
| `CC_AUTORESUME_DEFAULT_WAIT_HOURS` | `5` | Fallback wait when no `resets_at` can be determined; also used when verify fails and the wake is pushed |
| `CC_AUTORESUME_BALANCE_WARN` | `5` | Low-balance warning threshold for balance-style adapters |
| `CC_AUTORESUME_LOG` | `~/.cc-autoresume/log.jsonl` | Event log path |
| `CC_AUTORESUME_STATE_PATH` | `~/.cc-autoresume/state-<pid>.json` | State file path. By default each wrapper gets its own per-PID file; setting this env var only changes the current wrapper's file path |
| `CC_AUTORESUME_RESUME_HINT` | `继续` | Text injected on wake |
| `CC_AUTORESUME_ADAPTER` | `auto` | `auto` / `mock` / `anthropic` |
| `CC_AUTORESUME_DISABLE_SCREEN_SCAN` | — | Set to `1` to disable the screen scanner (only useful when API polling is also enabled) |
| `CC_AUTORESUME_ENABLE_API_POLL` | — | Set to `1` to **enable** periodic API polling for preemptive pause (off by default; needs an Anthropic OAuth token) |
| `CC_AUTORESUME_DISABLE_API_POLL` | — | Legacy alias kept for backward compatibility; `1` forces API polling off (the new default already does this) |
| `CC_AUTORESUME_RESTORE_MAX_AGE_HOURS` | `24` | If a prior `state-*.json` has `paused_at` older than this and its PID is dead, delete it during startup cleanup |
| `CC_AUTORESUME_TRIGGERS_FILE` | `~/.cc-autoresume/triggers.json` | Path to user-defined trigger pattern overrides |
| `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` | — | OAuth token. Falls back to `~/.claude/.credentials.json` |

## 8. How to set the env vars

Three ways, pick by frequency:

**One-shot** (good for quick experimentation):

```bash
CC_AUTORESUME_ENABLE_API_POLL=1 cc-autoresume --target=claude
```

Only applies to this single invocation.

**Current shell session** (`export`):

```bash
export CC_AUTORESUME_RESUME_HINT="quota's back, please resume the interrupted task"
export CC_AUTORESUME_DEFAULT_WAIT_HOURS=4
cc-autoresume --target=claude
```

Gone when you close the terminal — good for "tweaking today".

**Persistent across sessions** (add to your shell rc):

```bash
# in ~/.zshrc or ~/.bashrc
export CC_AUTORESUME_RESUME_HINT="quota's back, please resume the interrupted task"
# bonus: alias claude so you never have to type cc-autoresume by hand
alias claude='cc-autoresume --target=claude'
```

Run `source ~/.zshrc` (or open a new terminal) to apply.

**Verify what's actually in effect:**

```bash
env | grep CC_AUTORESUME
```

## 9. Adding custom trigger patterns

The built-in trigger set covers Claude Code, Codex and a generic Chinese-LLM pattern bank. If your model prints a different limit message, drop a JSON file at `~/.cc-autoresume/triggers.json` to extend the table:

```json
{
  "patterns": [
    "your custom limit phrase",
    "model-specific error code"
  ],
  "errorContextHints": ["Error", "失败"],
  "resetExtractors": [
    { "type": "relative", "pattern": "wait (\\d+) seconds", "unit": "sec" },
    { "type": "compound", "pattern": "(\\d+)\\s*minutes? remaining" }
  ],
  "busyMarkers": ["YOUR_SPINNER_CHARS"],
  "idleMarkers": ["\\[\\?25h"]
}
```

- `patterns` (`string[]`) — regex sources for the limit message. Strings are compiled with `new RegExp(s)`.
- `errorContextHints` (`string[]`) — a limit pattern only fires if at least one of these hint regexes also matches in the same buffer. Prevents the wrapper from being fooled by Claude explaining what rate limits are.
- `resetExtractors` — pull the wait time out of the message. Three shapes:
  - `{ "type": "absolute", "pattern": "..." }` — capture group 1 should be a timestamp (`Date.parse` or `HH:MM`).
  - `{ "type": "relative", "pattern": "...", "unit": "sec"|"min"|"hour" }` — capture group 1 is a number.
  - `{ "type": "compound", "pattern": "..." }` — capture group 1 is the number, group 2 is the unit (`秒`/`sec`/`分钟`/`min`/`小时`/`hour`/...).
- `busyMarkers` / `idleMarkers` — regex sources for the BUSY/IDLE state tracker.

User patterns are **merged on top of** the built-in set (additive, not replacement). Invalid regexes are skipped silently and logged to the log file.

## 10. Multiple terminals and state cleanup

By default each wrapper writes its own state file: `~/.cc-autoresume/state-<pid>.json`. This lets multiple terminal tabs run `cc-autoresume` at the same time without overwriting each other's `auto_resume`, `wake_at`, target, or PID.

If a wrapper is killed during a pause (manual exit, OS reboot, crash), the saved state is **not automatically resumed** on the next start. The state file does not contain the underlying Claude/Codex session id, so auto-attaching a new CLI with `-c` could resume the wrong conversation when multiple tabs existed. The safe behavior is to start fresh and let the user choose any CLI-level resume command explicitly.

Every startup still cleans the state directory: any `state-*.json` / legacy `state.json` whose PID is dead **and** whose `paused_at` is older than `CC_AUTORESUME_RESTORE_MAX_AGE_HOURS` is deleted directly. Files for live PIDs, dead-but-still-recent pauses, `log.jsonl`, and `triggers.json` are left untouched.

To manually clear all pause states:

```bash
rm ~/.cc-autoresume/state-*.json ~/.cc-autoresume/state.json 2>/dev/null
```

You can see cleanup on a given start by looking at the log:

```bash
tail -f ~/.cc-autoresume/log.jsonl | jq 'select(.event == "state_swept")'
```

## 11. Exiting

- A single `Ctrl+C` is forwarded to the wrapped CLI (acts as if you pressed it inside `claude`).
- Two `Ctrl+C` within 300ms force-kill the wrapper and its child.

## 12. License

[MIT](./LICENSE)
