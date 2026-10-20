# dsh-turn-notifier

DeepSeek Harness 宿主插件：**每轮对话正常完成时**弹一条通知，标题是会话名，正文是本轮回答的摘要。
用于「切出去干别的，答完叫我」。

## 通知长什么样

```
┌──────────────────────────────────────────┐
│ DeepSeek Harness                         │  ← 应用身份（Electron 原生）
│ 给通知加摘要                              │  ← 会话标题
│ 完成 · 12s                               │
│ 已改造完成。现在通知分两行：标题是会话名，  │  ← 摘要（去 markdown、按句收尾）
│ 正文是摘要……                             │
└──────────────────────────────────────────┘
```

点击通知会唤起窗口。

## 两条通道

| 通道 | 何时用 | 效果 |
|---|---|---|
| `client` | Web 页面还开着（默认，靠页面 2s 轮询心跳判定） | 由页面内的 `Notification` 弹出，**显示为 DeepSeek Harness 本身**，图标是包内鲸鱼图，无需任何系统授权 |
| `native` | 页面没在跑 | macOS 优先 `terminal-notifier`（标题/副标题/正文/鲸鱼缩略图/点击激活），失败退回 `osascript`；Linux 用 `notify-send -i`；Windows 用 PowerShell WinRT toast（`appLogoOverride` 鲸鱼图标） |

通知图标统一取自包内的 `assets/whale.png`（随插件分发，不需要各平台另找素材）；
`client` 通道通过 `/dsh-turn-notifier/icon.png` 路由取图。

宿主插件在每轮完成时把 `{会话名, 完成 · 耗时, 摘要}` 写进内存，
页面脚本通过 `GET /dsh-turn-notifier/last.json?after=<seq>` 取新事件
（轮询本身就是“页面在线”的心跳），两个路由都只接受回环来源。

## 行为细节

- 只在 `reason.kind === 'completed'` 时通知；用户中断、出错、被拦截、达到 max-tokens 都不通知。
- 默认跳过子代理（`header.origin === 'subagent'`）的会话，避免一次提问弹一屏。
- 摘要取本轮**最后一段**有内容的 assistant 文本，去掉代码块/markdown 标记、压平空白、
  按 `summaryChars` 截断并尽量停在句末标点上。
- 通知失败只写宿主日志，绝不影响会话本身。

## 安装

任选一种（`dsh plugin` 会把依赖写进 profile 的 `package.json`，
并自动把 `dsh-turn-notifier` 加进 `dsh.profile.bundles`；插件自己的
`cordis.patch.yml` 负责插入 Loader 条目）。`<profile>` 换成你的 profile 名，
桌面应用一般是 `desktop`，命令行 web 一般是 `web`：

```sh
# ① 从 GitHub Release 直接装（推荐）
dsh plugin --profile <profile> add "https://github.com/king-shao/dsh-turn-notifier/releases/latest/download/dsh-turn-notifier.tgz"

# ② 本地开发：链接源码目录
dsh plugin --profile <profile> add "link:/path/to/dsh-turn-notifier"

# ③ 本地打包好的 tgz
dsh plugin --profile <profile> add "/path/to/dsh-turn-notifier-1.0.0.tgz"

# ④ 已发布到 npm 时按包名安装
dsh plugin --profile <profile> add dsh-turn-notifier
```

**改动需要重启 DeepSeek Harness**（desktop profile 下 HMR 关闭）；注入行与路由都在启动时注册。

## 打包与发布

```sh
npm pack          # 产出 dsh-turn-notifier-<version>.tgz
npm publish       # 需要先把 package.json 的 name 改成你拥有的名字/scope
```

包内含：`lib/index.js`（宿主插件）、`assets/whale.png`（通知图标）、`cordis.patch.yml`（挂载声明）、
`icon.svg`（插件管理器图标）、`locale/{zh,en}.json`（`meta.title` / `meta.description`）、
`README.md`、`LICENSE`。`package.json` 的 `exports` 暴露了 `.`、`./locale/*.json`、`./icon`，
`dsh.bundle.patch` 指向 patch 文件。

## 配置

改 `cordis.patch.yml` 的 `config`：

| 键 | 默认 | 说明 |
|---|---|---|
| `title` | `DeepSeek Harness` | 会话没有标题时的通知标题 |
| `summaryChars` | `180` | 摘要长度（≥40 生效） |
| `skipSubagents` | `true` | 跳过子代理会话 |
| `minSeconds` | `0` | 只提醒耗时 ≥ N 秒的轮次 |
| `preferClient` | `true` | 页面在线时用页面内通知，避免与原生通知重复 |
| `sound` | `Glass` | 原生通道提示音；`false` 静音 |
| `icon` | `auto` | 通知图标：`auto` 用包内鲸鱼图，也可填绝对路径，`false` 关闭（旧名 `contentImage` 仍可用） |
| `activate` | `com.deepseek.dsh` | 点击原生通知激活的应用 |
| `backend` | `auto` | `terminal-notifier` / `osascript` / `auto`；Windows、Linux 按平台固定（powershell / notify-send） |
| `logFile` | `~/.dsh/turn-notifier.log` | 每次投递记一行 JSON；`''` 关闭 |

## 验证

```sh
tail -n 5 ~/.dsh/turn-notifier.log            # 每次该响时多一行（channel 字段说明走哪条通道）
curl -s 127.0.0.1:50450/dsh-turn-notifier/last.json   # 最近一次完成事件
```

## 卸载

```sh
dsh plugin --profile desktop remove dsh-turn-notifier
```

再从 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 删掉
`dsh-turn-notifier`，重启应用。

## 平台支持

插件本身是纯 JS，`dsh plugin add` 在任何平台都一样安装，不需要编译或额外运行时；
通知走哪条通道由运行环境自动选择。桌面应用和 `dsh web`（浏览器）都支持页面内通知，
浏览器首次会弹一次通知授权：

| 平台 | 页面开着（client） | 页面关闭（native） | 图标 |
|---|---|---|---|
| macOS | 应用自己的通知 | `terminal-notifier`（装了才有）→ `osascript` | 前两者带鲸鱼图，`osascript` 无图标 |
| Windows 10/11 | 应用自己的 toast | PowerShell WinRT toast | `appLogoOverride` 鲸鱼图标 |
| Linux | 应用自己的通知 | `notify-send` | `-i` 鲸鱼图标 |

`terminal-notifier` 是 macOS 上的**可选**增强（更好的排版、点击激活、图标）；
没装也能工作，只是退回 `osascript` 的朴素横幅。

## 限制

- 原生通道（页面没开时）依赖 `terminal-notifier` 的通知权限；本机该权限目前是关闭的，
  表现为通知不显示（插件会自动退回 `osascript`，但 Script Editor 的通知权限同样未登记）。
  需要时到「系统设置 → 通知」放行对应工具。日常开着页面用 `client` 通道不受影响。
- Windows 原生通道借用 Windows PowerShell 的 AUMID 发 toast，所以通知中心里显示的
  应用名是「Windows PowerShell」而不是 DeepSeek Harness；需要 Windows 10/11 且系统里有
  `powershell.exe`（没有时尝试 `pwsh.exe`）。页面开着时走 `client` 通道，显示的就是应用本身。
- Windows 上不支持自定义提示音名称，`sound: false` 会转为静音 toast，其余值用系统默认提示音。
- 页面轮询间隔 2s，通知最多延迟约 2s。
