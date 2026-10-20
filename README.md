# dsh-turn-notifier

DeepSeek Harness 宿主插件。每轮对话正常结束时发送一条系统通知，标题为会话名称，正文为本轮回答的摘要，用于在对话执行期间处理其他事务时获知完成状态。

## 通知内容

| 字段 | 取值 |
|---|---|
| 标题 | 会话名称；会话尚无标题时使用配置项 `title` |
| 副标题 | `完成 · <耗时>` |
| 正文 | 本轮回答的摘要 |
| 图标 | 包内 `assets/whale.png` |

点击通知可激活应用窗口。

## 投递通道

插件按运行环境自动选择通道，两者不会同时投递。

| 通道 | 触发条件 | 说明 |
|---|---|---|
| `client` | 页面处于运行状态 | 由页面内的 `Notification` 接口投递，以 DeepSeek Harness 自身身份显示，不需要额外的系统授权 |
| `native` | 页面未运行 | macOS 优先使用 `terminal-notifier`，不可用时回退 `osascript`；Linux 使用 `notify-send`；Windows 使用 PowerShell 的 WinRT toast |

页面以 2 秒间隔轮询宿主，轮询请求同时作为页面在线的心跳。宿主在每轮完成时将 `{会话名称, 耗时, 摘要}` 记录于内存，页面通过 `GET /dsh-turn-notifier/last.json?after=<seq>` 获取新事件，图标通过 `GET /dsh-turn-notifier/icon.png` 获取；两个路由均只接受回环地址的请求。

## 行为规则

- 仅在 `reason.kind === 'completed'` 时通知。用户中断、执行出错、策略拦截以及达到 max-tokens 的轮次均不通知。
- 默认跳过子代理会话（`header.origin === 'subagent'`），避免单次提问产生多条通知。
- 摘要取自本轮最后一段包含文本的 assistant 消息：移除 Markdown 标记、折叠空白，按 `summaryChars` 截断，并尽量在句末标点处结束。
- 通知投递失败仅记录宿主日志，不影响会话本身。

## 安装

`<profile>` 为 profile 名称：桌面应用通常为 `desktop`，命令行的 Web 组合通常为 `web`。

```sh
# 从 GitHub Release 安装
dsh plugin --profile <profile> add "https://github.com/king-shao/dsh-turn-notifier/releases/latest/download/dsh-turn-notifier.tgz"

# 本地开发：链接源码目录
dsh plugin --profile <profile> add "link:/path/to/dsh-turn-notifier"

# 本地构建产物
dsh plugin --profile <profile> add "/path/to/dsh-turn-notifier-<version>.tgz"

# 已发布到 npm 时按包名安装
dsh plugin --profile <profile> add dsh-turn-notifier
```

`dsh plugin` 会将依赖写入 profile 的 `package.json`，并将 `dsh-turn-notifier` 加入 `dsh.profile.bundles`；插件自身的 `cordis.patch.yml` 负责插入 Loader 条目。

注入行与路由均在宿主启动时注册，安装或升级后需要重启宿主。

## 配置

配置项位于 `cordis.patch.yml` 的 `config` 字段。

| 键 | 默认值 | 说明 |
|---|---|---|
| `title` | `DeepSeek Harness` | 会话尚无标题时使用的通知标题 |
| `summaryChars` | `180` | 摘要长度上限，取值不小于 40 时生效 |
| `skipSubagents` | `true` | 是否跳过子代理会话 |
| `minSeconds` | `0` | 仅提醒耗时不低于该值的轮次 |
| `preferClient` | `true` | 页面在线时使用页面内通知，避免与原生通知重复 |
| `sound` | `Glass` | 原生通道提示音名称；`false` 为静音 |
| `icon` | `auto` | 通知图标：`auto` 使用包内图标，也可指定绝对路径，`false` 为不显示；旧名称 `contentImage` 仍可识别 |
| `activate` | `com.deepseek.dsh` | 点击原生通知时激活的应用 |
| `backend` | `auto` | `terminal-notifier`、`osascript` 或 `auto`；Windows 与 Linux 固定按平台选择 |
| `logFile` | `~/.dsh/turn-notifier.log` | 每次投递记录一行 JSON；空字符串表示关闭 |

## 平台支持

插件由纯 JavaScript 实现，不含原生依赖，各平台均可通过 `dsh plugin add` 安装，无需编译或额外运行时。桌面应用与 `dsh web`（浏览器）均支持页面内通知；在浏览器中首次使用时需授权通知权限。

| 平台 | 页面在线 | 页面未运行 | 图标 |
|---|---|---|---|
| macOS | 应用自身通知 | `terminal-notifier`（可选）→ `osascript` | `terminal-notifier` 与页面内通知显示图标，`osascript` 不显示 |
| Windows 10/11 | 应用自身 toast | PowerShell WinRT toast | `appLogoOverride` |
| Linux | 应用自身通知 | `notify-send` | `-i` 参数 |

macOS 上的 `terminal-notifier` 为可选增强项，提供更完整的排版、点击激活与图标；未安装时回退至 `osascript` 的纯文本横幅。

## 诊断

```sh
tail -n 5 ~/.dsh/turn-notifier.log                  # 每次投递记录一行，channel 字段标明通道
curl -s http://<host>:<port>/dsh-turn-notifier/last.json   # 最近一次完成事件
```

## 卸载

```sh
dsh plugin --profile <profile> remove dsh-turn-notifier
```

随后从 profile 的 `package.json` 中移除 `dsh.profile.bundles` 内的 `dsh-turn-notifier`，并重启宿主。

## 打包与发布

```sh
npm pack       # 生成 dsh-turn-notifier-<version>.tgz
npm publish    # 发布前需将 package.json 的 name 改为自有名称或 scope
```

包内含：`lib/index.js`（宿主插件）、`assets/whale.png`（通知图标）、`cordis.patch.yml`（挂载声明）、`icon.svg`（插件管理器图标）、`locale/{zh,en}.json`（`meta.title` 与 `meta.description`）、`README.md`、`LICENSE`。

`package.json` 的 `exports` 暴露 `.`、`./package.json`、`./locale/*.json` 与 `./icon`；`dsh.bundle.patch` 指向 patch 文件。

## 限制

- 原生通道依赖平台的通知服务与授权状态。未授予通知权限时，通知不会展示，仅记录日志；页面在线时不受此限制。
- Windows 原生通道借用 Windows PowerShell 的 AUMID 发送 toast，通知中心显示的应用名称为“Windows PowerShell”，而非 DeepSeek Harness。该通道要求 Windows 10/11 且存在 `powershell.exe`，缺失时尝试 `pwsh.exe`。
- Windows 不支持自定义提示音名称：`sound: false` 生成静音 toast，其他取值使用系统默认提示音。
- 页面轮询间隔为 2 秒，通知最多延迟约 2 秒。
- 宿主进程未运行时不会产生通知。

## 许可

MIT。通知图标取自 DeepSeek Harness 应用图标，属于 DeepSeek 品牌素材；再分发或公开发布前请自行确认授权范围。
