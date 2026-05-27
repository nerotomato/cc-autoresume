# cc-autoresume

[![English](https://img.shields.io/badge/lang-English-lightgrey)](./README.md)
[![简体中文](https://img.shields.io/badge/lang-简体中文-blue)](./README.zh-CN.md)

> 一个命令行 wrapper，用 PTY 包住 Claude Code / Codex / ccs；检测到订阅额度限制后自动暂停，等额度重置后在同一个终端会话里自动恢复。

## 1. 这是什么

`cc-autoresume` 是一个 CLI 工具，安装后提供 `cc-autoresume` 可执行命令。它不是守护进程、不是服务、不是 GUI，也不会替代 Claude Code / Codex / ccs。你用它替换平时启动目标 CLI 的命令，它会在内部用 PTY 启动真正的目标进程，所以 stdin、stdout、raw mode、窗口大小变化和信号转发都保持原生终端体验。

它解决的是长时间使用 Claude Code 时，5 小时 / 7 天订阅额度耗尽后会卡住等待的问题。检测到限额后，`cc-autoresume` 会记录唤醒时间、暂停等待，并在额度重置后向同一个 PTY 注入配置好的恢复提示词；如果用户已经回到终端继续操作，则不会打扰。

对官方 Anthropic provider 下的 Claude Code，现在主路径是读取 Claude Code `statusLine` stdin 里的结构化 `rate_limits` 数据。对 Codex、ccs 第三方 provider，以及没有稳定 `rate_limits` 的模型输出，仍保留屏幕扫描和自定义 triggers 作为降级方案。

## 2. 工作原理

```text
cc-autoresume claude [args]
  │
  ├─ 启动 PTY wrapper
  │
  ├─ 对 claude / ccs 启动方式：
  │   ├─ 读取用户现有 ~/.claude/settings.json 里的 statusLine command
  │   ├─ 在 ~/.cc-autoresume/ 生成临时 spy 脚本
  │   ├─ 注入 --settings '{"statusLine":{"command":"spy"}}'
  │   └─ 通过 spy 保留用户原有 statusLine 输出
  │
  ├─ Claude Code 运行中：
  │   ├─ Claude Code 按自己的 statusLine 刷新节奏调用 command
  │   ├─ spy 把 stdin JSON 写入 rate-limits-<pid>.json
  │   ├─ spy 把同一份 JSON 透传给用户原 statusLine command
  │   └─ RateLimitsWatcher 读取本地文件并检测 threshold
  │
  ├─ 撞墙 / 到达阈值时：
  │   ├─ 写入 state-<pid>.json
  │   ├─ 写入 statusline-hint-<pid>.txt
  │   ├─ 在 statusLine 末尾追加自动恢复提示
  │   └─ 调度 wake_at = resets_at + buffer
  │
  └─ 唤醒 / 退出时：
      ├─ 清除 statusLine hint
      ├─ 删除临时 spy/runtime 文件
      └─ 需要时恢复同一个 PTY 会话
```

主要模块：

- **wrapper** (`src/wrapper.ts`)：通过 `node-pty` 启动目标 CLI，桥接终端 I/O，注入临时 statusLine settings，管理暂停/唤醒清理，并发送恢复按键序列。
- **statusline-spy** (`src/statusline-spy.ts`)：生成临时 spy 脚本，保留用户原 statusLine command，写入捕获到的 JSON，写入/清除自动恢复提示，并清扫陈旧 runtime 文件。
- **rate-limits-watcher** (`src/rate-limits-watcher.ts`)：轮询很小的本地 `rate-limits-<pid>.json` 文件，解析 `rate_limits.five_hour` / `seven_day`，按 `CC_AUTORESUME_THRESHOLD` 触发暂停，并对同一轮限额做防抖。
- **screen-scanner** (`src/screen-scanner.ts`)：Codex、ccs 第三方 provider、只打印文本限额错误的 CLI 使用的降级检测器；它会剥离 ANSI、维护滚动缓冲、匹配 triggers，并追踪 BUSY / IDLE 状态。
- **scheduler** (`src/scheduler.ts`)：管理唤醒 timer 和墙钟 heartbeat，避免电脑休眠后 `setTimeout` 被冻住导致错过唤醒时间。
- **triggers** (`src/triggers/`)：内置 Claude、Codex、通用中文模型限额提示关键词，可用 `~/.cc-autoresume/triggers.json` 追加扩展。

## 3. 检测路径

| 启动命令 | 主检测方式 | 说明 |
|---|---|---|
| `cc-autoresume claude` / `cc-autoresume --target=claude` | 官方 Anthropic endpoint 下使用 statusLine spy + `rate_limits` watcher | `ANTHROPIC_BASE_URL` 为空或指向官方 Anthropic 时启用；屏幕扫描默认仍作为兜底 |
| `cc-autoresume ccs claude` | statusLine spy + `rate_limits` watcher | `--settings` 会注入到 `claude` provider 参数后面，并通过 ccs 传给 Claude Code |
| `cc-autoresume ccs codex` / `cc-autoresume ccs glm` | 屏幕扫描 + 自定义 triggers | spy 仍可保留/追加 statusLine 输出，但不把第三方 provider 的 `rate_limits` 当成稳定契约 |
| `cc-autoresume codex` / `cc-autoresume --target=codex` | 屏幕扫描 + 自定义 triggers | 不需要 Anthropic 鉴权 |

wrapper 不再做周期性 Anthropic API polling。官方 Claude 主路径读取的是 statusLine spy 写出的本地 JSON 文件；屏幕扫描路径则是 PTY 输出事件驱动。

## 4. statusLine 兼容性

`cc-autoresume` 不要求用户安装 `cc-usage-bar` 或任何 statusLine 工具，也不会永久修改 `~/.claude/settings.json`。

启动时它会读取当前 statusLine command，然后用临时 `--settings` 启动 Claude Code，让 statusLine command 指向 spy 脚本。spy 做三件事：

1. 把 Claude Code 推给 statusLine 的 stdin JSON 写到 `rate-limits-<pid>.json`；
2. 如果用户原本有 statusLine command，把同一份 JSON 继续喂给原 command；
3. 当 wrapper 正在等待自动恢复时，在原 statusLine 输出后追加 `cc-autoresume` 提示。

示例：

```text
# RateLimitsWatcher 检测到接近额度上限（utilization >= threshold）
original-status | cc-autoresume: 接近额度上限，14:03:30 自动恢复

# 屏幕扫描检测到已达额度上限（Claude Code 输出了限额提示文本）
original-status | cc-autoresume: 已达额度上限，14:03:30 自动恢复

# 用户没有 statusLine；只会在暂停等待期间显示
cc-autoresume: 接近额度上限，14:03:30 自动恢复
```

所有额度类型（包括 7 天周额度）均会调度自动恢复。wrapper 会保持运行，在额度重置后唤醒会话。

唤醒、跳过唤醒或 wrapper 退出后，hint 文件会被删除。下一次 statusLine 刷新时，追加提示就会消失。

## 5. ccs 支持

可以直接包住 `ccs`：

```bash
# 通过 ccs 使用 Claude provider：走 statusLine rate_limits 路径
cc-autoresume ccs claude

# 通过 ccs 使用 Codex / GLM / 其它 provider：走屏幕扫描降级路径
cc-autoresume ccs codex
cc-autoresume ccs glm

# 等价的显式 target 写法
cc-autoresume --target=ccs -- claude
```

对 `ccs claude`，`cc-autoresume` 会把 `--settings <json>` 注入到 provider 名称之后，所以最终 Claude Code 进程能收到临时 statusLine 覆盖。

对 `ccs codex`、`ccs glm` 和其它第三方 provider，`cc-autoresume` 不假设存在稳定的 `rate_limits` 结构。限额检测来自屏幕扫描和可选的自定义 triggers。

## 6. 跨平台支持

`cc-autoresume` 支持 **macOS、Linux 和 Windows**。

| 平台 | PTY 后端 | 说明 |
|---|---|---|
| macOS / Linux | Unix PTY (`forkpty`) | 完整支持 |
| Windows 10 1809+ | ConPTY | 需要 Windows Terminal 或支持 ConPTY 的终端 |

statusLine spy 脚本是 Node.js 脚本（`.js`），通过 `node` 调用，在所有平台上行为一致，不依赖 bash 或其他 shell。

Windows 上安装和使用方式相同 —— `npm install`、`npm run build`，然后在 PowerShell、cmd 或 Windows Terminal 中使用：

```powershell
# PowerShell / cmd
cc-autoresume claude
cc-autoresume claude -- --dangerously-skip-permissions
```

运行时文件（`~/.cc-autoresume/`）存储在用户主目录下（Windows 为 `%USERPROFILE%`，Unix 为 `$HOME`），通过 `os.homedir()` 统一解析。

## 7. 前提依赖

| 依赖 | 原因 |
|---|---|
| Node.js ≥ 20 | wrapper 和 `node-pty` 需要 |
| 目标 CLI 已安装 | 本机需要已有可用的 `claude`、`codex` 和/或 `ccs` |
| Claude Code 已登录 | 正常使用 Claude Code 需要；官方 statusLine `rate_limits` 也依赖登录态 |
| 有效 Claude 订阅 | 如果希望拿到 5h / 7d 订阅窗口，需要订阅账号 |

如果目标命令不在 `PATH` 上，`cc-autoresume` 会像直接运行该目标命令一样失败。

## 8. 安装

### 方式 A：从 npm 安装

包尚未发布。发布后使用：

```bash
npm install -g cc-autoresume
cc-autoresume --target=claude -- --help
```

### 方式 B：从源码安装

```bash
git clone https://github.com/nerotomato/cc-autoresume.git
cd cc-autoresume
npm install
npm run build

# 直接运行本地 bin
./bin/cc-autoresume --target=claude

# 或链接到 PATH
npm link
cc-autoresume --target=claude
```

## 9. 使用

用 `cc-autoresume` 替换平时启动目标 CLI 的命令：

```bash
# 自动检测：优先 claude，然后 codex
cc-autoresume

# 显式目标
cc-autoresume claude
cc-autoresume codex
cc-autoresume ccs claude
cc-autoresume ccs codex

# 等价的 flag 写法
cc-autoresume --target=claude
cc-autoresume --target=ccs -- claude

# 透传目标 CLI 参数
cc-autoresume claude -- --resume
cc-autoresume claude -- "总结一下当前仓库"
cc-autoresume ccs claude -- --resume
```

| 参数 / 写法 | 说明 |
|---|---|
| `cc-autoresume claude` / `codex` / `ccs ...` | 位置参数形式选择目标 |
| `--target=auto\|claude\|codex\|ccs` | 显式选择目标；`auto` 时优先 `claude`，然后 `codex` |
| `-- <args...>` | 显式分隔符，之后的内容原样透传给目标 CLI |
| wrapper 不认识的 flag | 直接透传给目标 CLI |

## 10. 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CC_AUTORESUME_TARGET` | `auto` | 等价于 `--target` |
| `CC_AUTORESUME_THRESHOLD` | `99` | statusLine utilization 达到该百分比时暂停 |
| `CC_AUTORESUME_DEFAULT_WAIT_HOURS` | `5` | 拿不到 reset 时间时的兜底等待 |
| `CC_AUTORESUME_BALANCE_WARN` | `5` | 余额型 adapter 预留阈值 |
| `CC_AUTORESUME_LOG` | `~/.cc-autoresume/log.jsonl` | JSONL 事件日志路径 |
| `CC_AUTORESUME_STATE_DIR` | `~/.cc-autoresume` | per-PID state、spy、rate-limit、hint 文件所在目录 |
| `CC_AUTORESUME_STATE_PATH` | `~/.cc-autoresume/state-<pid>.json` | 覆盖当前 wrapper 的 state 文件路径 |
| `CC_AUTORESUME_RESUME_HINT` | `继续` | 唤醒时注入到 CLI 的文本 |
| `CC_AUTORESUME_ADAPTER` | `auto` | `auto` / `mock` / `anthropic`；高级校验/测试开关 |
| `CC_AUTORESUME_DISABLE_SCREEN_SCAN` | — | 设为 `1` 关闭屏幕扫描；只有 statusLine watcher 路径可用时才建议这样做 |
| `CC_AUTORESUME_RATE_LIMITS_POLL_MS` | `10000` | 读取 `rate-limits-<pid>.json` 的本地文件轮询间隔 |
| `CC_AUTORESUME_RATE_LIMITS_MAX_STALENESS_MS` | `120000` | 超过这个时间未更新的 statusLine JSON 会被忽略 |
| `CC_AUTORESUME_RESTORE_MAX_AGE_HOURS` | `24` | 启动清理时，PID 已死的旧 state 文件超过该时长会被删除 |
| `CC_AUTORESUME_TRIGGERS_FILE` | `~/.cc-autoresume/triggers.json` | 用户自定义 trigger 扩展文件 |
| `CC_AUTORESUME_DISABLE_SESSION_TRACKING` | — | 设为 `1` 关闭给 `claude` 自动注入 `--session-id` |
| `CC_AUTORESUME_DISABLE_WAKE_HEARTBEAT` | — | 设为 `1` 关闭暂停期间的墙钟 heartbeat |
| `CC_AUTORESUME_LIMIT_MENU_KEYS` | — | 覆盖 Claude 撞墙菜单出现后发送的按键序列。空值表示 `claude` / `ccs claude` 内置默认发送 `enter`；可用 `up,enter` 等值覆盖 |
| `ANTHROPIC_BASE_URL` | — | 为空/官方地址时启用 Claude statusLine watcher；非官方 Claude 启动走屏幕扫描降级 |

示例：

```bash
# 自定义恢复提示词
CC_AUTORESUME_RESUME_HINT="额度恢复了，请继续之前的任务" cc-autoresume claude

# 调整本地 statusLine JSON 读取间隔
CC_AUTORESUME_RATE_LIMITS_POLL_MS=5000 cc-autoresume claude

# 通过 ccs 使用 Claude provider
cc-autoresume ccs claude
```

## 11. 输出物与清理

| 路径 | 创建时机 | 作用 | 清理方式 |
|---|---|---|---|
| `~/.cc-autoresume/state-<pid>.json` | 暂停时 | 当前 wrapper 状态：target、PID、唤醒时间、trigger、auto-resume 标志、session id | 唤醒后清理；启动时清扫陈旧文件 |
| `~/.cc-autoresume/log.jsonl` | 启动时 | 事件日志（`startup`、`wrapper_start`、`statusline_pause_due`、`screen_pause_due`、`wake_sent`、`verify_pushed`、`state_swept` 等） | 保留 |
| `~/.cc-autoresume/spy-<pid>.js` | `claude` / `ccs` wrapper 启动时 | 临时 statusLine spy command | wrapper 退出时删除；后续启动会清扫 PID 已死的残留 |
| `~/.cc-autoresume/rate-limits-<pid>.json` | 首次 statusLine 调用时 | 最近一次捕获到的 statusLine stdin JSON，每次刷新覆盖写 | wrapper 退出时删除；后续启动会清扫 PID 已死的残留 |
| `~/.cc-autoresume/statusline-hint-<pid>.txt` | 暂停等待期间 | 追加到 statusLine 末尾的自动恢复提示 | 唤醒 / 跳过 / wrapper 退出时删除 |
| `~/.cc-autoresume/triggers.json` | 用户创建 | 自定义屏幕扫描 triggers | cleanup 不会修改 |

这些 runtime 文件按 PID 隔离，多个终端 tab 不会互相覆盖。rate-limit 和 hint 文件都是覆盖写，不是追加写，大小保持稳定。

## 12. 自定义 trigger

屏幕扫描仍用于 Codex、ccs 第三方 provider，以及只打印文本限额错误的模型。可以创建 `~/.cc-autoresume/triggers.json` 扩展内置关键词：

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

用户 triggers 会追加到内置表上。无效正则会被跳过并写入日志。

## 13. 会话 ID 管理

`target=claude` 时，wrapper 会自动生成 UUID，并以 `--session-id <uuid>` 传给 Claude Code，除非用户已经传了 `--session-id`、`--resume`、`--continue`、`--fork-session` 或 `--from-pr` 这类 session 相关参数。

同一个 UUID 会保存到 `state-<pid>.json` 的 `session_id` 字段，方便手动恢复时精确找到会话：

```bash
cat ~/.cc-autoresume/state-*.json | jq -r '.session_id'
claude --resume <session-id>
```

关闭这个功能：

```bash
CC_AUTORESUME_DISABLE_SESSION_TRACKING=1 cc-autoresume claude
```

## 14. 休眠 / 唤醒

电脑休眠期间，Node 的单发 timer 可能因为 monotonic clock 冻结而延迟。`cc-autoresume` 在暂停期间会保留一个墙钟 heartbeat：每 60 秒比较一次 `Date.now()` 和 `wake_at`。如果电脑唤醒时已经超过额度重置时间，下一次 heartbeat 会立即恢复。

- 只在暂停期间运行。
- 唤醒或 wrapper 退出后立即清除。
- 休眠后的最坏恢复延迟约 60 秒。
- 可用 `CC_AUTORESUME_DISABLE_WAKE_HEARTBEAT=1` 关闭。

## 15. Claude 撞墙菜单自动选择

Claude Code 撞墙后可能显示交互菜单。对 `claude` 和 `ccs claude`，`cc-autoresume` 默认会在检测到限额 500ms 后发送 `enter`，确认 Claude Code 默认选中的 `Stop and wait for limit to reset`。

只有当你的 Claude Code 版本默认高亮的不是等待选项时，才需要覆盖：

```bash
export CC_AUTORESUME_LIMIT_MENU_KEYS="up,up,enter"
# 或用无效/no-op 值关闭内置默认行为
export CC_AUTORESUME_LIMIT_MENU_KEYS="none"
```

支持的键名：`up`、`down`、`left`、`right`、`enter`、`esc`、`tab`、`space`。

## 16. 退出

- 单次 `Ctrl+C` 会透传给被包装的 CLI。
- 300ms 内连续两次 `Ctrl+C` 会强制结束 wrapper 和子进程。

## 17. 许可证

[MIT](./LICENSE)
