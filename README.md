# cc-autoresume

[![English](https://img.shields.io/badge/lang-English-blue)](./README.md)
[![简体中文](https://img.shields.io/badge/lang-简体中文-lightgrey)](./README.zh-CN.md)

> A command-line wrapper for Claude Code / Codex / ccs that detects subscription quota limits, pauses safely, and resumes the same terminal session after the reset time.

## 1. What is this

`cc-autoresume` is a CLI tool, installed as the `cc-autoresume` executable. It is not a daemon, service, GUI, or replacement for Claude Code / Codex / ccs. You run it instead of the command you normally use, and it starts the real target CLI inside a PTY so stdin, stdout, raw mode, resize events, and signals behave like a normal terminal session.

It solves the long-session problem where Claude Code hits the 5h / 7d subscription quota and waits for hours. When a limit is detected, `cc-autoresume` records the wake time, pauses, and later injects the configured resume hint into the same PTY if the user has not already returned.

For Claude Code on the official Anthropic provider, the primary detection path is now Claude Code's `statusLine` JSON stream. For Codex, ccs third-party providers, and model outputs that do not expose stable `rate_limits`, the wrapper keeps the existing screen scanner and custom trigger support as a fallback.

## 2. How it works

```text
cc-autoresume claude [args]
  │
  ├─ starts a PTY wrapper
  │
  ├─ for claude / ccs launches:
  │   ├─ reads the user's existing ~/.claude/settings.json statusLine command
  │   ├─ creates a temporary spy script in ~/.cc-autoresume/
  │   ├─ injects --settings '{"statusLine":{"command":"spy"}}'
  │   └─ preserves the original statusLine output through the spy
  │
  ├─ while Claude Code runs:
  │   ├─ Claude Code calls statusLine on its normal refresh cadence
  │   ├─ the spy captures stdin JSON into rate-limits-<pid>.json
  │   ├─ the spy forwards the same JSON to the user's original statusLine
  │   └─ RateLimitsWatcher reads the file and detects threshold hits
  │
  ├─ on quota limit:
  │   ├─ writes state-<pid>.json
  │   ├─ writes statusline-hint-<pid>.txt
  │   ├─ appends an auto-resume hint to the statusLine output
  │   └─ schedules wake_at = resets_at + buffer
  │
  └─ on wake / exit:
      ├─ clears the statusLine hint
      ├─ deletes temporary spy/runtime files
      └─ resumes the PTY session when appropriate
```

Main modules:

- **wrapper** (`src/wrapper.ts`) — starts the target CLI via `node-pty`, bridges terminal I/O, injects the temporary statusLine settings, owns pause/wake cleanup, and sends the resume sequence.
- **statusline-spy** (`src/statusline-spy.ts`) — creates the temporary spy script, preserves the user's original statusLine command, writes the captured JSON file, writes/clears the auto-resume hint, and sweeps stale runtime files.
- **rate-limits-watcher** (`src/rate-limits-watcher.ts`) — polls the tiny local `rate-limits-<pid>.json` file, parses `rate_limits.five_hour` / `seven_day`, applies `CC_AUTORESUME_THRESHOLD`, and triggers pause once per limit window.
- **screen-scanner** (`src/screen-scanner.ts`) — fallback detector for Codex, ccs third-party providers, and any CLI that only prints limit messages. It strips ANSI, keeps a rolling buffer, matches trigger patterns, and tracks BUSY / IDLE state.
- **scheduler** (`src/scheduler.ts`) — owns wake timers and the wall-clock heartbeat so a laptop wake after `wake_at` resumes promptly instead of waiting for a frozen `setTimeout`.
- **triggers** (`src/triggers/`) — built-in rate-limit patterns for Claude, Codex, and generic Chinese model output, optionally extended by `~/.cc-autoresume/triggers.json`.

## 3. Detection paths

| Launch command | Primary detection | Notes |
|---|---|---|
| `cc-autoresume claude` / `cc-autoresume --target=claude` | statusLine spy + `rate_limits` watcher when `ANTHROPIC_BASE_URL` is empty or points at official Anthropic | Screen scan remains available as a fallback unless disabled |
| `cc-autoresume ccs claude` | statusLine spy + `rate_limits` watcher | `--settings` is injected after the `claude` provider argument so it reaches Claude Code through ccs |
| `cc-autoresume ccs codex` / `cc-autoresume ccs glm` | screen scan + custom triggers | The spy can still preserve/augment statusLine output, but third-party provider `rate_limits` is not treated as a stable contract |
| `cc-autoresume codex` / `cc-autoresume --target=codex` | screen scan + custom triggers | Works without Anthropic auth |

The wrapper no longer does periodic Anthropic API polling. The steady-state official-Claude path reads a local JSON file written by the statusLine spy. Screen-scan paths are event-driven from PTY output.

## 4. statusLine compatibility

`cc-autoresume` does not require the user to install `cc-usage-bar` or any other statusLine tool. It also does not permanently edit `~/.claude/settings.json`.

At startup it reads the current statusLine command, then starts Claude Code with a temporary `--settings` override that points to the spy script. The spy does three things:

1. captures Claude Code's statusLine stdin JSON into `rate-limits-<pid>.json`;
2. pipes the same JSON into the user's original statusLine command, if one exists;
3. appends the `cc-autoresume` hint while the wrapper is waiting for an automatic resume.

Examples:

```text
# Rate-limits watcher detected approaching quota (utilization >= threshold)
original-status | cc-autoresume: 接近额度上限，14:03:30 自动恢复

# Screen scanner detected quota hit (Claude Code printed limit message)
original-status | cc-autoresume: 已达额度上限，14:03:30 自动恢复

# User has no statusLine; only shown while paused
cc-autoresume: 接近额度上限，14:03:30 自动恢复
```

Auto-resume is scheduled for all quota types, including 7-day limits. The wrapper stays alive and wakes the session when the quota resets.

After wake, skip, or wrapper exit, the hint file is removed. On the next statusLine refresh the extra text disappears.

## 5. ccs support

`ccs` can be wrapped directly:

```bash
# Claude provider through ccs: statusLine rate_limits path
cc-autoresume ccs claude

# Codex / GLM / other providers through ccs: screen-scan fallback path
cc-autoresume ccs codex
cc-autoresume ccs glm

# Equivalent explicit target form
cc-autoresume --target=ccs -- claude
```

For `ccs claude`, `cc-autoresume` injects `--settings <json>` after the provider name, so the final Claude Code process receives the temporary statusLine override.

For `ccs codex`, `ccs glm`, and other third-party providers, `cc-autoresume` does not assume a stable `rate_limits` schema. Limit detection comes from the screen scanner and optional custom triggers.

## 6. Cross-platform support

`cc-autoresume` works on **macOS, Linux, and Windows**.

| Platform | PTY backend | Notes |
|---|---|---|
| macOS / Linux | Unix PTY (`forkpty`) | Fully supported |
| Windows 10 1809+ | ConPTY | Requires Windows Terminal or a ConPTY-capable terminal |

The statusLine spy script is a Node.js script (`.js`), invoked via `node`, so it runs identically on all platforms. No bash or shell dependency is required.

On Windows, install and run the same way — `npm install`, `npm run build`, then use `cc-autoresume` from PowerShell, cmd, or Windows Terminal:

```powershell
# PowerShell / cmd
cc-autoresume claude
cc-autoresume claude -- --dangerously-skip-permissions
```

Runtime files (`~/.cc-autoresume/`) are stored under the user's home directory (`%USERPROFILE%` on Windows, `$HOME` on Unix), resolved via `os.homedir()`.

## 7. Prerequisites

| Requirement | Why |
|---|---|
| Node.js ≥ 20 | Required by the wrapper and `node-pty` |
| Target CLI installed | `claude`, `codex`, and/or `ccs` must already work on your machine |
| Claude Code logged in | Required for normal Claude Code usage and for official statusLine `rate_limits` to exist |
| Active Claude subscription | Required if you expect 5h / 7d subscription windows from Claude Code |

If the target command is not on `PATH`, `cc-autoresume` will fail the same way the target command would fail.

## 8. Installation

### Option A — npm registry

The package is not published yet. Once published:

```bash
npm install -g cc-autoresume
cc-autoresume --target=claude -- --help
```

### Option B — source checkout

```bash
git clone https://github.com/nerotomato/cc-autoresume.git
cd cc-autoresume
npm install
npm run build

# Run local bin
./bin/cc-autoresume --target=claude

# Or link onto PATH
npm link
cc-autoresume --target=claude
```

## 9. Usage

Replace the command that normally starts the target CLI:

```bash
# auto-detect: prefers claude, then codex
cc-autoresume

# explicit targets
cc-autoresume claude
cc-autoresume codex
cc-autoresume ccs claude
cc-autoresume ccs codex

# equivalent flag form
cc-autoresume --target=claude
cc-autoresume --target=ccs -- claude

# pass target arguments through
cc-autoresume claude -- --resume
cc-autoresume claude -- "summarize this repo"
cc-autoresume ccs claude -- --resume
```

| Flag / form | Meaning |
|---|---|
| `cc-autoresume claude` / `codex` / `ccs ...` | Positional target form |
| `--target=auto\|claude\|codex\|ccs` | Explicit target selection; `auto` prefers `claude`, then `codex` |
| `-- <args...>` | Explicit separator. Everything after it is forwarded verbatim to the target CLI |
| unknown flags | Forwarded to the target CLI |

## 10. Configuration

| Variable | Default | Description |
|---|---|---|
| `CC_AUTORESUME_TARGET` | `auto` | Same as `--target` |
| `CC_AUTORESUME_THRESHOLD` | `99` | Pause when statusLine utilization reaches this percentage |
| `CC_AUTORESUME_DEFAULT_WAIT_HOURS` | `5` | Fallback wait when no reset time can be determined |
| `CC_AUTORESUME_BALANCE_WARN` | `5` | Reserved for balance-style adapters |
| `CC_AUTORESUME_LOG` | `~/.cc-autoresume/log.jsonl` | JSONL event log path |
| `CC_AUTORESUME_STATE_DIR` | `~/.cc-autoresume` | Runtime directory for per-PID state, spy, rate-limit, and hint files |
| `CC_AUTORESUME_STATE_PATH` | `~/.cc-autoresume/state-<pid>.json` | Override the current wrapper's state file path |
| `CC_AUTORESUME_RESUME_HINT` | `继续` | Text injected on wake |
| `CC_AUTORESUME_ADAPTER` | `auto` | `auto` / `mock` / `anthropic`; advanced verification/testing knob |
| `CC_AUTORESUME_DISABLE_SCREEN_SCAN` | — | Set to `1` to disable screen scanning. Only safe when the statusLine watcher path applies |
| `CC_AUTORESUME_RATE_LIMITS_POLL_MS` | `10000` | Local file polling interval for `rate-limits-<pid>.json` |
| `CC_AUTORESUME_RATE_LIMITS_MAX_STALENESS_MS` | `120000` | Ignore captured statusLine JSON older than this |
| `CC_AUTORESUME_RESTORE_MAX_AGE_HOURS` | `24` | Startup cleanup threshold for stale state files whose PID is dead |
| `CC_AUTORESUME_TRIGGERS_FILE` | `~/.cc-autoresume/triggers.json` | User-defined trigger extension file |
| `CC_AUTORESUME_DISABLE_SESSION_TRACKING` | — | Set to `1` to stop auto-injecting `--session-id` into `claude` |
| `CC_AUTORESUME_DISABLE_WAKE_HEARTBEAT` | — | Set to `1` to disable wall-clock heartbeat during pauses |
| `CC_AUTORESUME_LIMIT_MENU_KEYS` | — | Override key sequence sent after a Claude limit menu appears. Empty means built-in `enter` for `claude` / `ccs claude`; use values like `up,enter` to override |
| `ANTHROPIC_BASE_URL` | — | Official/empty enables the Claude statusLine watcher path; non-official Claude launches use screen scan fallback |

Examples:

```bash
# Use a custom resume hint
CC_AUTORESUME_RESUME_HINT="quota is back, continue the task" cc-autoresume claude

# Tune local statusLine JSON polling
CC_AUTORESUME_RATE_LIMITS_POLL_MS=5000 cc-autoresume claude

# Run ccs with the Claude provider
cc-autoresume ccs claude
```

## 11. Outputs and cleanup

| Path | Created when | Purpose | Cleanup |
|---|---|---|---|
| `~/.cc-autoresume/state-<pid>.json` | On pause | Current wrapper state: target, PID, wake time, trigger, auto-resume flag, session id | Cleared after wake; stale old files swept on startup |
| `~/.cc-autoresume/log.jsonl` | On startup | Event log (`startup`, `wrapper_start`, `statusline_pause_due`, `screen_pause_due`, `wake_sent`, `verify_pushed`, `state_swept`, …) | Kept |
| `~/.cc-autoresume/spy-<pid>.js` | On `claude` / `ccs` wrapper startup | Temporary statusLine spy script (Node.js) | Deleted on wrapper exit; stale files swept on later startup if PID is dead |
| `~/.cc-autoresume/rate-limits-<pid>.json` | First statusLine invocation | Last captured statusLine stdin JSON, overwritten each refresh | Deleted on wrapper exit; stale files swept on later startup if PID is dead |
| `~/.cc-autoresume/statusline-hint-<pid>.txt` | While paused | Text appended to statusLine output | Deleted on wake / skip / wrapper exit |
| `~/.cc-autoresume/triggers.json` | User-created | Custom screen-scan triggers | Never modified by cleanup |

Runtime files are per PID, so multiple terminal tabs do not overwrite each other. The rate-limit and hint files are overwritten, not appended, so their size stays bounded.

## 12. Custom trigger patterns

Screen scan still matters for Codex, ccs third-party providers, and model outputs that only print textual limit errors. Add `~/.cc-autoresume/triggers.json` to extend the built-in patterns:

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

User patterns are merged on top of the built-in set. Invalid regexes are skipped and logged.

## 13. Session ID management

When `target=claude`, the wrapper auto-generates a UUID and passes it to Claude Code as `--session-id <uuid>`, unless the user already supplied a session-related argument such as `--session-id`, `--resume`, `--continue`, `--fork-session`, or `--from-pr`.

The same UUID is saved in `state-<pid>.json` under `session_id`, which makes manual recovery unambiguous:

```bash
cat ~/.cc-autoresume/state-*.json | jq -r '.session_id'
claude --resume <session-id>
```

Disable this with:

```bash
CC_AUTORESUME_DISABLE_SESSION_TRACKING=1 cc-autoresume claude
```

## 14. Suspend / resume

During laptop sleep, Node timers can be delayed because the monotonic clock freezes. `cc-autoresume` keeps a wall-clock heartbeat while paused: every 60 seconds it compares `Date.now()` with `wake_at`. If the machine wakes after the quota reset time has already passed, the next heartbeat resumes immediately.

- Runs only while paused.
- Cleared on wake or wrapper exit.
- Worst-case post-wake latency is about 60 seconds.
- Disable with `CC_AUTORESUME_DISABLE_WAKE_HEARTBEAT=1`.

## 15. Auto-selecting Claude's limit menu

Claude Code may show a menu after a quota hit. For `claude` and `ccs claude`, `cc-autoresume` sends `enter` by default 500ms after detecting the limit, which confirms Claude Code's default `Stop and wait for limit to reset` choice.

Override it only if your Claude Code version highlights a different option by default:

```bash
export CC_AUTORESUME_LIMIT_MENU_KEYS="up,up,enter"
# or disable the built-in default by setting an invalid/no-op value
export CC_AUTORESUME_LIMIT_MENU_KEYS="none"
```

Supported keys: `up`, `down`, `left`, `right`, `enter`, `esc`, `tab`, `space`.

## 16. Exiting

- One `Ctrl+C` is forwarded to the wrapped CLI.
- Two `Ctrl+C` presses within 300ms force-kill the wrapper and child.

## 17. License

[MIT](./LICENSE)
