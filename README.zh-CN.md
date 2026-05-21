# cc-autoresume

[![English](https://img.shields.io/badge/lang-English-lightgrey)](./README.md)
[![简体中文](https://img.shields.io/badge/lang-简体中文-blue)](./README.zh-CN.md)

> 一个**命令行工具**，把 Claude Code / Codex CLI 包在 PTY 里运行；在订阅额度即将耗尽时自动暂停，等额度重置后自动唤醒并继续对话。

## 1. 这是什么

`cc-autoresume` 是一个 **CLI 工具**（安装后会有一个 `cc-autoresume` 可执行命令），不是服务、不是守护进程、不是 GUI。你像运行 `claude` / `codex` 一样在终端里运行它，它会在内部用 PTY 拉起真正的目标 CLI，体验和直接启动目标 CLI 完全一致。

它用来解决长时间使用 Claude Code（或 Codex CLI）订阅版时被 **5 小时 / 7 天额度** 卡住的问题。

> ⚠️ **这个工具不会替代 Claude Code / Codex，它只是包装它们。** 你必须先在本机装好可用的 `claude` 和/或 `codex` CLI，详见下文 [前提依赖](#4-前提依赖)。

它在你和真正的 `claude` / `codex` CLI 之间架了一层。**默认只做一件事**：实时监听被包装 CLI 的输出，对照内置关键词表（Claude / Codex / 国内大模型通用中文）匹配限额错误（**屏幕扫描**，事件驱动、零延迟、覆盖任意 CLI），一旦撞墙立即暂停。

暂停触发时，wrapper 会**按需调一次** Anthropic OAuth `usage` 接口（前提是能拿到 token）取精确 `resets_at`。整个生命周期的网络消耗就这么多——**没有周期性轮询**。

等额度重置时，wrapper 会先看用户是不是已经回到终端在用：如果在用，就**保持静默不打扰**；如果还是离开状态，就注入 `ESC` + 提示词 + `Enter`，让原任务继续跑下去。

如果你需要预防性暂停（撞墙前主动停），设 `CC_AUTORESUME_ENABLE_API_POLL=1` 打开周期性 API 轮询。

整个过程中，你看到的仍然是原生 `claude` / `codex` 的终端体验：输入、输出、TTY 大小、原始模式、信号转发都被完整透传。

## 2. 工作原理

```
              ┌─────────────────────────────────────────────────┐
              │                  cc-autoresume                  │
              │                                                 │
   你的终端 ──▶│   ┌─────────────────────────────────────────┐   │──▶ claude / codex
              │   │ 屏幕扫描器（事件驱动，默认且唯一）      │   │   (跑在 node-pty 子进程里)
              │   │   • 匹配限额错误关键词                  │   │
              │   │   • 追踪 BUSY / IDLE 状态               │   │
              │   │   • 撞墙时按需调一次 Anthropic API      │   │
              │   │     取精确 resets_at（有 token 才调）   │   │
              │   └─────────────────────────────────────────┘   │
              │              │ 暂停 / 唤醒                       │
              │   ESC + 提示词 + Enter（仅在用户离开时）         │
              └─────────────────────────────────────────────────┘
                      │
                      ▼
              ~/.cc-autoresume/{state-<pid>.json, log.jsonl}

   Opt-in: CC_AUTORESUME_ENABLE_API_POLL=1 可同时启用
   周期性 API 轮询，实现预防性暂停
```

- **wrapper** (`src/wrapper.ts`)：用 [`node-pty`](https://github.com/microsoft/node-pty) fork 一个 PTY 子进程跑目标 CLI，把 stdin/stdout/SIGWINCH/SIGINT/SIGTERM 桥接过去；子进程输出同时喂给屏幕扫描器。
- **screen-scanner** (`src/screen-scanner.ts`)：剥离 ANSI、维护滑动缓冲、匹配关键词、抽取 reset 时间、并跑一个由 spinner / cursor-hide marker 驱动的 BUSY/IDLE 状态机。
- **triggers** (`src/triggers/`)：`claude` / `codex` / 通用中文（DeepSeek / Qwen / Doubao / GLM）三套内置关键词表，可被 `~/.cc-autoresume/triggers.json` 追加扩展。
- **adapter** (`src/adapters/anthropic.ts`)：调用 `https://api.anthropic.com/api/oauth/usage`，既用于周期性轮询，也作为屏幕触发时的 reset 时间兜底（一次性调用）。
- **scheduler** (`src/scheduler.ts`)：管理唤醒定时器；唤醒前做一次校验，校验不通过就把唤醒时间再推 `defaultWaitHours`（默认 5h）继续等，不会再 5 次后放弃。
- **state-machine** (`src/state-machine.ts`)：决定唤醒时间的优先级（文本抽取 → API → 默认值）、以及超过 `maxWaitHours` 的 `paused_long` 模式。

### 暂停后到底会不会自动恢复？

| 触发源 | 触发时用户 BUSY？ | `auto_resume` | 唤醒时行为 |
|---|---|---|---|
| 屏幕扫描捕获到限额错误 | （定义上必然 BUSY） | `true` | 注入 `ESC + 提示词 + Enter` |
| API 轮询 `utilization ≥ threshold`，且 5s 内屏幕扫描看到过 BUSY | 是 | `true` | 注入 `ESC + 提示词 + Enter` |
| API 轮询 `utilization ≥ threshold`，但用户当前 IDLE | 否 | `false` | 只清状态，不注入任何东西 |
| 任意路径，但唤醒到点时检测到用户已自己回来用 | — | （被覆盖） | 跳过注入——用户已经回来了 |

最后一条"唤醒前再看一眼"避免了一个常见坑：你 5h 后没回来 → wrapper 自动续上；但如果你提前回来开了新任务，wrapper 就不会再硬塞"继续"打乱你的上下文。

### 轮询开销说明 —— 会不会一直占资源？

**默认模式（只屏幕扫描）**：环境零开销。屏幕扫描是 PTY 数据流的事件回调，没有定时器、没有轮询、不碰网络。整个生命周期的网络消耗：**每次撞墙最多 1 次 HTTPS GET**（取 `resets_at`，如果能拿到 token）。典型会话：0 次 API 调用；撞墙一次：1 次。

**Opt-in：`CC_AUTORESUME_ENABLE_API_POLL=1`** 会开启周期性 API 轮询用于预防性暂停。节奏按当前最高利用率自适应：

| 当前最高利用率 | 轮询间隔 |
|---|---|
| `< 80%` | 每 **10 分钟** 一次 |
| `80% – 95%` | 每 **2 分钟** 一次 |
| `95% – 99%` | 每 **30 秒** 一次 |
| `≥ 99%`（即将触顶） | 每 **10 秒** 一次 |
| Adapter 报错（暂时性 / 鉴权失败） | 指数退避，最多 **5 分钟** |
| **暂停期间** | **完全不轮询**，只挂一个定时器等到 reset |

**没有后台守护进程**——你一退出 `cc-autoresume`，所有定时器立即销毁。

> **为什么默认关 API 轮询？** 屏幕扫描已经能即时捕获所有限额事件，预防性暂停的实际价值有限（用户撞墙前通常自己也会停）。默认关闭让 Codex / 国内大模型用户、以及没登录 OAuth 的 Anthropic 用户都能开箱即用，日志里不会出现"找不到 token"的报错。

## 3. 输出物

| 路径 | 作用 | 默认值 |
|---|---|---|
| `~/.cc-autoresume/state-<pid>.json` | 当前 wrapper 状态快照（`version: 2`），含 `trigger`（`5h`/`7d`/`both`/`screen`/`manual`）、`auto_resume` 标志、`wake_source`（`api`/`text`/`default`）、唤醒时间、PID 等 | `CC_AUTORESUME_STATE_PATH`（显式切回单文件模式） |
| `~/.cc-autoresume/log.jsonl` | 行式 JSON 日志，记录每一次 `startup` / `snapshot` / `pause_due` / `screen_pause_due` / `wake_sent` / `wake_skipped_user_active` / `verify_pushed` 等事件 | `CC_AUTORESUME_LOG` |
| 终端横幅 | 暂停 / 唤醒 / 校验推迟 / 余额预警时打印到 stderr 的一行提示，不污染被包装 CLI 的正常输出 | — |

## 4. 前提依赖

在安装 `cc-autoresume` 之前，请确保：

| 依赖项 | 原因 |
|---|---|
| **Node.js ≥ 20** | wrapper 自身在 Node 20+ 运行；`node-pty` 预编译二进制也面向该范围 |
| **本机已安装 `claude` 和/或 `codex` CLI** | 本工具只是**包装**它们，不会自带也不会替代它们。请用 `which claude` / `which codex` 确认。Claude Code 安装指引见 [claude.com/claude-code](https://www.claude.com/claude-code) |
| **Claude Code 已登录** *（仅 API 轮询路径需要）* | `cc-autoresume` 会读取 `~/.claude/.credentials.json`（Claude Code 在 `claude login` 之后写入的文件）。也可以显式设置 `ANTHROPIC_AUTH_TOKEN` 或 `CLAUDE_CODE_OAUTH_TOKEN`。Codex / 国内大模型走屏幕扫描，不需要 token |
| **有效的 Claude 订阅** *（仅 API 轮询路径需要）* | `usage` 接口只为订阅账号返回 5h / 7d 窗口数据。Codex / 国内大模型走屏幕扫描，无需订阅 |

如果 `claude` 不在 `PATH` 上，`cc-autoresume --target=claude` 会直接以 `command not found` 退出——请先修好底层 CLI 的安装。

## 5. 安装

### 方式 A：从 npm 市场安装（推荐）

```bash
# 全局安装
npm install -g cc-autoresume

# 验证
cc-autoresume --target=claude -- --help
```

> 安装后 `postinstall` 脚本会自动给 `node-pty` 的 `spawn-helper` 补上可执行权限（修复部分 macOS / Linux 环境下的 EACCES 问题）。

### 方式 B：从 GitHub 源码安装

```bash
# 1. 克隆并构建
git clone https://github.com/nerotomato/cc-autoresume.git
cd cc-autoresume
npm install
npm run build

# 2A. 直接用本地 bin（开发场景）
./bin/cc-autoresume --target=claude

# 2B. 软链接到全局 PATH
npm link
cc-autoresume --target=claude
```

> `npm install` 会拉取 `node-pty` 并触发 `postinstall` 修复权限。

## 6. 使用

最基本的用法：用 `cc-autoresume` 替换你平时启动 `claude` / `codex` 的命令。

```bash
# 自动识别 claude 或 codex
cc-autoresume

# 指定目标 CLI
cc-autoresume --target=claude
cc-autoresume --target=codex

# 把参数透传给目标 CLI（用 -- 分隔）
cc-autoresume --target=claude -- --resume
cc-autoresume --target=claude -- "总结一下当前仓库"
```

支持的命令行参数：

| 参数 | 说明 |
|---|---|
| `--target=auto\|claude\|codex` | 选择目标 CLI，`auto` 时优先 `claude`，再 `codex` |
| 任何其它 flag | cc-autoresume 自己不认识的参数会直接透传给目标 CLI——`cc-autoresume --target=claude --allow-dangerously-skip-permissions` 直接就能用 |
| `-- <args...>` | 可选的显式分隔符。`--` 之后的内容无条件原样透传（当目标参数看起来像 wrapper 的 flag 时有用，比如 `-- --target=foo`） |

## 7. 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `CC_AUTORESUME_TARGET` | `auto` | 等价于 `--target` |
| `CC_AUTORESUME_THRESHOLD` | `99` | API utilization 达到该百分比即触发暂停（仅 API 轮询路径） |
| `CC_AUTORESUME_MAX_WAIT_HOURS` | `12` | 唤醒等待若超过该小时数，进入 `paused_long`（只提示不自动唤醒） |
| `CC_AUTORESUME_DEFAULT_WAIT_HOURS` | `5` | 拿不到 `resets_at` 时的兜底等待；唤醒前校验失败 push 也用这个 |
| `CC_AUTORESUME_BALANCE_WARN` | `5` | 余额型 adapter 的低余额警告阈值 |
| `CC_AUTORESUME_LOG` | `~/.cc-autoresume/log.jsonl` | 事件日志路径 |
| `CC_AUTORESUME_STATE_PATH` | `~/.cc-autoresume/state-<pid>.json` | 状态文件路径。默认每个 wrapper 一份 PID 分片文件；设置该变量只会覆盖当前 wrapper 的状态文件路径 |
| `CC_AUTORESUME_RESUME_HINT` | `继续` | 唤醒时注入到 CLI 的提示词 |
| `CC_AUTORESUME_ADAPTER` | `auto` | `auto` / `mock` / `anthropic` |
| `CC_AUTORESUME_DISABLE_SCREEN_SCAN` | — | 设为 `1` 关闭屏幕扫描（仅当同时打开 API 轮询时有意义） |
| `CC_AUTORESUME_ENABLE_API_POLL` | — | 设为 `1` **打开**周期性 API 轮询用于预防性暂停（默认关；需要 Anthropic OAuth token） |
| `CC_AUTORESUME_DISABLE_API_POLL` | — | 旧别名，向后兼容用；`1` 强制关闭 API 轮询（其实新默认已经关了） |
| `CC_AUTORESUME_RESTORE_MAX_AGE_HOURS` | `24` | 启动清理时，PID 已死且 `paused_at` 超过这个小时数的 `state-*.json` 会被直接删除 |
| `CC_AUTORESUME_TRIGGERS_FILE` | `~/.cc-autoresume/triggers.json` | 用户自定义关键词表路径 |
| `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` | — | OAuth token，未配置时回退读取 `~/.claude/.credentials.json` |

## 8. 如何配置环境变量

下面三种方式按使用频率挑：

**一次性临时用（验证一个 flag 时最方便）**

```bash
CC_AUTORESUME_ENABLE_API_POLL=1 cc-autoresume --target=claude
```

只对这一次启动生效，退出后忘掉。

**当前 shell 会话持久（用 `export`）**

```bash
export CC_AUTORESUME_RESUME_HINT="额度恢复了，请继续之前没跑完的任务"
export CC_AUTORESUME_DEFAULT_WAIT_HOURS=4
cc-autoresume --target=claude
```

关掉终端就没了，适合"今天调一调"。

**跨会话永久（写进 shell rc）**

把要长期生效的几行 `export` 加到你常用 shell 的启动文件：

```bash
# ~/.zshrc 或 ~/.bashrc
export CC_AUTORESUME_RESUME_HINT="额度恢复了，请继续之前没跑完的任务"
# 顺手把 claude 起手别名也写上，以后敲 claude 就自动包了 cc-autoresume：
alias claude='cc-autoresume --target=claude'
```

改完 `source ~/.zshrc`（或新开一个终端）生效。

**验证当前生效的值**

```bash
env | grep CC_AUTORESUME
```

看到你预期的几行就 OK。

## 9. 添加自定义关键词

内置关键词表覆盖了 Claude Code / Codex / 国内大模型通用中文三套。如果你用的模型打印出来的限额提示不在表里，可以在 `~/.cc-autoresume/triggers.json` 放一份 JSON 追加扩展：

```json
{
  "patterns": [
    "你自定义的限额关键词",
    "某模型特有的错误码"
  ],
  "errorContextHints": ["Error", "失败"],
  "resetExtractors": [
    { "type": "relative", "pattern": "等待\\s*(\\d+)\\s*秒", "unit": "sec" },
    { "type": "compound", "pattern": "还需(\\d+)\\s*(分钟|小时)" }
  ],
  "busyMarkers": ["你的 SPINNER 字符"],
  "idleMarkers": ["\\[\\?25h"]
}
```

各字段含义：

- `patterns` (`string[]`)：限额提示的正则源码。会用 `new RegExp(s)` 编译。
- `errorContextHints` (`string[]`)：限额关键词命中后还要至少有一个错误上下文 hint 同时出现，才会触发暂停。防止把 Claude 在回答里解释 rate limit 概念的话误判成真错误。
- `resetExtractors`：从提示里抽 reset 时间。三种类型：
  - `{ "type": "absolute", "pattern": "..." }`：捕获组 1 是时间戳（`Date.parse` 能识别的格式，或 `HH:MM`）。
  - `{ "type": "relative", "pattern": "...", "unit": "sec"|"min"|"hour" }`：捕获组 1 是数字。
  - `{ "type": "compound", "pattern": "..." }`：捕获组 1 是数字，组 2 是单位（`秒`/`sec`/`分钟`/`min`/`小时`/`hour`/...）。
- `busyMarkers` / `idleMarkers`：BUSY / IDLE 状态跟踪用的正则源码。

用户关键词是**附加**到内置表上的（不替换）。无效正则会被静默跳过并写入日志文件。

## 10. 多终端并存与状态清理

默认情况下，每个 wrapper 都写自己的状态文件：`~/.cc-autoresume/state-<pid>.json`。这样多个终端 tab 同时用 `cc-autoresume` 包 Claude / Codex 时，不会互相覆盖 `auto_resume`、`wake_at`、目标 CLI 或 PID。

如果 wrapper 在暂停期间被打断（手动退出、电脑重启、进程崩溃），下次启动**不会自动接管旧 state 恢复等待**。state 文件里没有底层 Claude/Codex 的 session id；多个 tab 存在时，自动给新 CLI 加 `-c` 可能续到错误的对话。安全做法是干净启动，由用户自己显式选择 CLI 层面的续会话命令。

每次启动还会顺手清理状态目录：凡是 `state-*.json` / 老格式 `state.json` 里记录的 PID 已死，且 `paused_at` 超过 `CC_AUTORESUME_RESTORE_MAX_AGE_HOURS` 的文件，都会被直接删除。PID 还活着的文件、PID 已死但还在最大等待时间内的文件、`log.jsonl`、`triggers.json` 都不会动。

如果想手动清空所有暂停状态：

```bash
rm ~/.cc-autoresume/state-*.json ~/.cc-autoresume/state.json 2>/dev/null
```

排查启动清理行为可以看日志：

```bash
tail -f ~/.cc-autoresume/log.jsonl | jq 'select(.event == "state_swept")'
```

## 11. 退出与中断

- 单次 `Ctrl+C`：被透传给目标 CLI（等价于在 CLI 里按 Ctrl+C）；
- 300ms 内连续两次 `Ctrl+C`：强制结束 wrapper 与子 CLI。

## 12. 许可证

[MIT](./LICENSE)
