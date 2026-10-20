/**
 * dsh-turn-notifier —— 每轮对话完成时弹出系统通知，正文带本轮回答的摘要。
 *
 * 监听宿主 core 事件 `session/event`：
 *   - `turn/start`        记录本轮开始时间
 *   - `assistant/message` 收集本轮模型输出的文本块
 *   - `turn/end`          仅在 reason.kind === 'completed' 时发通知，正文取最后一段回答的摘要
 *
 * 跳过：用户中断、出错、被策略拦截、达到 max-tokens；以及子代理会话。
 *
 * 通知通道：
 *   1. `client`：Web 页面还在跑时，通过注入的脚本用浏览器/Electron 的 Notification API
 *      弹通知 —— 显示为 DeepSeek Harness 本身（自带图标），不需要额外系统授权。
 *      三个平台都走这条（Windows 上即应用自己的 toast）。
 *   2. `native`：页面没在跑时的兜底 —— macOS 优先 terminal-notifier、否则 osascript；
 *      Linux 走 notify-send；Windows 走 Windows PowerShell 的 WinRT toast。
 */
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'dsh-turn-notifier'

/** 只依赖 core：apply 立即执行，不等待任何服务就绪。 */
export const inject = []

const MAX_BODY = 400
const DEFAULT_SUMMARY_CHARS = 180
/** 页面轮询与“客户端仍在线”的判定窗口。 */
const CLIENT_HEARTBEAT_MS = 10_000

const TERMINAL_NOTIFIER_CANDIDATES = [
  '/opt/homebrew/bin/terminal-notifier',
  '/usr/local/bin/terminal-notifier',
]

/** 包内自带的鲸鱼图标：随插件一起分发，任何平台都不用另找素材。 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUNDLED_ICON = join(PACKAGE_ROOT, 'assets', 'whale.png')
const ICON_ROUTE = '/dsh-turn-notifier/icon.png'

/** 注入到 Web 页面里的脚本：轮询宿主，拿到新一轮完成事件后发通知。 */
const CLIENT_SCRIPT = `(function () {
  if (window.__dshTurnNotifier) return
  window.__dshTurnNotifier = true
  var seen = 0
  function ensurePermission() {
    if (typeof Notification === 'undefined') return Promise.resolve(false)
    if (Notification.permission === 'granted') return Promise.resolve(true)
    if (Notification.permission === 'denied') return Promise.resolve(false)
    if (!Notification.requestPermission) return Promise.resolve(false)
    // 普通浏览器里权限是异步申请的：等到结果再决定是否消费这条事件。
    return Notification.requestPermission()
      .then(function (state) { return state === 'granted' })
      .catch(function () { return false })
  }
  function show(data) {
    var title = data.title || 'DeepSeek Harness'
    var options = {
      body: data.subtitle ? data.subtitle + '\\n' + (data.body || '') : (data.body || '本轮回答已完成'),
      tag: 'dsh-turn-notifier',
      icon: data.icon || '/dsh-turn-notifier/icon.png',
      silent: false
    }
    var notification = new Notification(title, options)
    notification.onclick = function () {
      try { window.focus(); notification.close() } catch (error) {}
    }
  }
  function tick() {
    fetch('/dsh-turn-notifier/last.json?after=' + seen, { cache: 'no-store' })
      .then(function (response) { return response.ok ? response.json() : null })
      .then(function (data) {
        if (!data || !data.seq || data.seq <= seen) return
        ensurePermission().then(function (granted) {
          // 没权限就保留游标，下次轮询继续尝试，避免这条事件被吃掉。
          if (!granted) return
          try { show(data); seen = data.seq } catch (error) {}
        })
      })
      .catch(function () {})
  }
  setTimeout(tick, 1200)
  setInterval(tick, 2000)
})()`

/** 往页面注入脚本加载器；路由不在时静默失败，绝不影响页面启动。 */
const INJECT_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;'
  + 'var s=document.createElement("script");s.src="/dsh-turn-notifier/client.js";'
  + 's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

/** AppleScript 字符串字面量转义；同时压平换行，避免破坏命令。 */
function appleScriptText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .trim()
    .slice(0, MAX_BODY)
}

/** 兜底：非控制字符、非空、长度受限的提示音名。 */
function safeSound(value) {
  const sound = String(value ?? '').trim()
  return /^[A-Za-z0-9 _-]{1,40}$/.test(sound) ? sound : ''
}

/** 去掉 markdown 标记、压平空白，留下适合通知展示的纯文本。 */
function stripMarkdown(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}([-*+]|\d{1,3}\.)\s+/gm, '')
    .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, ' ')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 截到 max 字符，尽量停在句末标点上，避免截断半个句子。 */
function shorten(text, max) {
  if (text.length <= max) return text
  const slice = text.slice(0, max)
  const marks = ['。', '！', '？', '；', '. ', '! ', '? ', '; ']
  let cut = -1
  for (const mark of marks) cut = Math.max(cut, slice.lastIndexOf(mark))
  const body = cut >= max * 0.5 ? slice.slice(0, cut + 1) : slice
  return `${body.trim()}…`
}

function formatElapsed(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m${rest.toString().padStart(2, '0')}s`
}

function firstExisting(paths) {
  for (const path of paths) {
    if (path && existsSync(path)) return path
  }
  return ''
}

/** DSH 应用图标：从宿主可执行文件反推 .app 的 Resources/icon.png。 */
function dshIconPath() {
  const fromExecutable = (() => {
    try {
      return join(dirname(dirname(process.execPath)), 'Resources', 'icon.png')
    } catch {
      return ''
    }
  })()
  return firstExisting([fromExecutable, '/Applications/DeepSeek Harness.app/Contents/Resources/icon.png'])
}

/**
 * 读会话标题。`sessionTitle` 服务把会话日志折叠成最新标题，
 * 对本插件启动前就已存在的标题同样有效；缺失时退回会话 header 上的名字。
 */
function sessionTitleOf(ctx, session) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined
    const snapshot = service?.get?.(session)
    const fromService = snapshot?.title ?? snapshot?.name
    if (typeof fromService === 'string' && fromService.trim()) return fromService.trim()
  } catch {
    // 老宿主没有该服务时静默回落。
  }
  const header = session?.header
  for (const candidate of [header?.title, header?.name]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}

function resolveLogFile(value) {
  if (typeof value !== 'string' || !value.trim()) return ''
  const raw = value.trim()
  return raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
}

function resolveOptions(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const summaryChars = Number.isFinite(raw.summaryChars) && raw.summaryChars >= 40
    ? Math.floor(raw.summaryChars)
    : DEFAULT_SUMMARY_CHARS
  // icon（旧名 contentImage）：'auto' 用包内鲸鱼图标，其次退回应用图标；false 关闭。
  const iconOption = raw.icon === undefined ? raw.contentImage : raw.icon
  const iconPath = iconOption === false
    ? ''
    : typeof iconOption === 'string' && iconOption.trim() && iconOption !== 'auto'
      ? iconOption.trim()
      : (existsSync(BUNDLED_ICON) ? BUNDLED_ICON : dshIconPath())
  return {
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'DeepSeek Harness',
    sound: raw.sound === false ? '' : safeSound(raw.sound ?? 'Glass'),
    skipSubagents: raw.skipSubagents !== false,
    minSeconds: Number.isFinite(raw.minSeconds) && raw.minSeconds > 0 ? raw.minSeconds : 0,
    logFile: resolveLogFile(raw.logFile),
    summaryChars,
    iconPath,
    contentImage: iconPath,
    // 点击通知时激活的应用；false 表示不激活。
    activate: raw.activate === false ? '' : String(raw.activate ?? 'com.deepseek.dsh').trim(),
    backend: raw.backend === 'osascript' || raw.backend === 'terminal-notifier'
      ? raw.backend
      : 'auto',
    // 页面在线时优先用页面内的应用通知，避免与原生通知重复。
    preferClient: raw.preferClient !== false,
  }
}

/** 可选的本地诊断日志：仅当配置了 logFile 时写入，写失败不影响通知。 */
function logDelivery(options, entry) {
  if (!options.logFile) return
  try {
    appendFileSync(options.logFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
  } catch {
    // 诊断日志不可写就放弃。
  }
}

/** 从一条 assistant 消息里取出可见文本（跳过 reasoning / 工具调用等块）。 */
function textOfAssistantMessage(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type !== 'text') continue
    const text = typeof block.text === 'string' ? block.text : ''
    if (text.trim()) parts.push(text)
  }
  return parts.join('\n').trim()
}

/** terminal-notifier 用自己的参数解析：以 - 或 [ 开头的值会被当成选项。 */
function safeArgument(value, maxLength = MAX_BODY) {
  const text = String(value ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, maxLength)
  return /^[[-]/.test(text) ? ` ${text}` : text
}

/** 只接受回环来源的请求：这是本地通知端点，不对外提供服务。 */
function isLoopbackRequest(req) {
  try {
    const host = String(req?.headers?.host ?? '')
    return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)
  } catch {
    return false
  }
}

function denyRequest(res) {
  try {
    res.statusCode = 403
    res.end('forbidden')
  } catch {
    // 忽略
  }
}

/** 转义进 XML 文本节点的字符。 */
function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/g, ' ')
    .trim()
    .slice(0, MAX_BODY)
}

/**
 * 生成 Windows toast 的 PowerShell 脚本。
 * XML 与脚本都走 base64，避免引号、换行和中文在 shell 传参过程中被改写。
 * 导出仅为便于在非 Windows 机器上校验生成结果。
 */
export function buildWindowsToastScript({ title, subtitle, body }, { withSound = true, iconPath = '' } = {}) {
  const lines = [title, subtitle, body]
    .filter((line) => typeof line === 'string' && line.trim())
    .map((line) => `<text>${xmlEscape(line)}</text>`)
    .join('')
  // appLogoOverride 只认本地文件 URI；路径里的空格由 pathToFileURL 处理。
  const logo = (() => {
    if (!iconPath) return ''
    try {
      const src = xmlEscape(pathToFileURL(iconPath).href)
      return `<image placement="appLogoOverride" hint-crop="circle" src="${src}"/>`
    } catch {
      return ''
    }
  })()
  const audio = withSound
    ? '<audio src="ms-winsoundevent:Notification.Default"/>'
    : '<audio silent="true"/>'
  const xml = `<toast activationType="foreground"><visual><binding template="ToastGeneric">${lines}${logo}</binding></visual>${audio}</toast>`
  const encodedXml = Buffer.from(xml, 'utf8').toString('base64')
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null',
    `$xmlString = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedXml}'))`,
    // WinRT 投影在 PowerShell 5.1 里两种实例化写法都能见到，按可用性依次尝试。
    'try { $xml = [Windows.Data.Xml.Dom.XmlDocument]::new() } catch { $xml = New-Object Windows.Data.Xml.Dom.XmlDocument }',
    '$xml.LoadXml($xmlString)',
    'try { $toast = [Windows.UI.Notifications.ToastNotification]::new($xml) } catch { $toast = New-Object Windows.UI.Notifications.ToastNotification $xml }',
    // Windows PowerShell 在开始菜单里注册的 AUMID：借用它，未注册的脚本才有 toast 身份。
    "$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)',
  ].join('\n')
}

/** Windows：用 Windows PowerShell 的 WinRT 投影弹 toast，pwsh.exe 作为第二选择。 */
function notifyWindows(onError, options, payload) {
  const script = buildWindowsToastScript(payload, {
    withSound: Boolean(options.sound),
    iconPath: options.iconPath,
  })
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const binaries = ['powershell.exe', 'pwsh.exe']
  const attempt = (index) => {
    if (index >= binaries.length) return
    execFile(
      binaries[index],
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { timeout: 10_000, windowsHide: true },
      (error) => {
        if (!error) return
        // 极简环境里可能没有 powershell.exe，再试 pwsh.exe；两个都缺才上报。
        if (error.code === 'ENOENT' && index + 1 < binaries.length) {
          attempt(index + 1)
          return
        }
        onError(error)
      },
    )
  }
  attempt(0)
}

/** 发送原生通知；失败只记日志，绝不影响会话本身。 */
function notifyNative(ctx, options, { title, subtitle, body, group }) {
  const onError = (error) => {
    try {
      ctx?.logger?.warn?.('turn-notifier: notification failed: %o', error)
    } catch {
      // 日志不可用时保持安静。
    }
  }

  const terminalNotifier = firstExisting(TERMINAL_NOTIFIER_CANDIDATES)
  const backend = process.platform === 'win32'
    ? 'powershell'
    : process.platform === 'linux'
      ? 'notify-send'
      : options.backend === 'auto'
        ? (terminalNotifier ? 'terminal-notifier' : 'osascript')
        : options.backend

  /** 朴素版兜底：标题/副标题/正文 + 提示音，不依赖第三方工具的通知权限。 */
  const fallbackToOsascript = () => {
    if (process.platform !== 'darwin') return
    let script = `display notification "${appleScriptText(body)}" with title "${appleScriptText(title)}"`
    if (subtitle) script += ` subtitle "${appleScriptText(subtitle)}"`
    if (options.sound) script += ` sound name "${appleScriptText(options.sound)}"`
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 10_000 }, (error) => {
      if (error) onError(error)
    })
  }

  try {
    logDelivery(options, { event: 'deliver', channel: 'native', backend, title, subtitle, body })

    if (process.platform === 'win32') {
      notifyWindows(onError, options, { title, subtitle, body })
      return
    }

    if (process.platform === 'linux') {
      const args = ['-a', options.title]
      if (options.iconPath) args.push('-i', options.iconPath)
      args.push(title, subtitle ? `${body} · ${subtitle}` : body)
      execFile(
        'notify-send',
        args,
        { timeout: 10_000 },
        (error) => {
          if (error) onError(error)
        },
      )
      return
    }

    if (backend === 'terminal-notifier' && terminalNotifier) {
      const args = [
        '-title', safeArgument(title, 120),
        '-subtitle', safeArgument(subtitle, 160),
        '-message', safeArgument(body),
        '-group', safeArgument(group || 'dsh-turn-notifier', 120),
      ]
      if (options.sound) args.push('-sound', safeArgument(options.sound, 40))
      if (options.activate) args.push('-activate', safeArgument(options.activate, 120))
      if (options.contentImage) args.push('-contentImage', options.contentImage)
      execFile(terminalNotifier, args, { timeout: 10_000 }, (error) => {
        if (!error) return
        // 通知权限被关（exit 3）或工具不可用时，退回 osascript，保证一定有提醒。
        onError(error)
        fallbackToOsascript()
      })
      return
    }

    fallbackToOsascript()
  } catch (error) {
    onError(error)
  }
}

/** 注册页面轮询用的两个本地路由（纯读取，不做任何写入）。 */
function registerClientRoutes(ctx, runtime, options) {
  const send = (res, status, contentType, body) => {
    try {
      res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' })
      res.end(body)
    } catch {
      // 连接已断开时忽略。
    }
  }

  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-turn-notifier/client.js',
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) return denyRequest(res)
      send(res, 200, 'text/javascript; charset=utf-8', CLIENT_SCRIPT)
    },
  })

  let iconBytes
  ctx.webServer.register({
    kind: 'exact',
    path: ICON_ROUTE,
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) return denyRequest(res)
      try {
        iconBytes ??= readFileSync(options.iconPath || BUNDLED_ICON)
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=86400',
          'content-length': String(iconBytes.length),
        })
        res.end(iconBytes)
      } catch {
        send(res, 404, 'text/plain; charset=utf-8', 'icon not found')
      }
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-turn-notifier/last.json',
    handler: (req, res) => {
      if (!isLoopbackRequest(req)) return denyRequest(res)
      // 每次轮询同时作为“页面仍在线”的心跳。
      runtime.lastClientPollAt = Date.now()
      let after = 0
      try {
        after = Number(new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('after')) || 0
      } catch {
        after = 0
      }
      const last = runtime.last
      const payload = last && last.seq > after ? last : null
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(payload ?? {}))
    },
  })

  logDelivery(options, { event: 'routes-registered' })
}

export function apply(ctx, config) {
  const options = resolveOptions(config)
  /** sessionId -> { startedAt, turn, texts } */
  const turns = new Map()
  /** 最近一次完成事件 + 页面心跳时间。 */
  const runtime = { seq: 0, last: null, lastClientPollAt: 0 }

  const forget = (sessionId) => {
    if (sessionId !== undefined) turns.delete(sessionId)
  }

  try {
    if (typeof ctx?.on !== 'function') return
    ctx.on('session/disposed', (session) => {
      forget(session?.id)
    })
  } catch {
    // 宿主没有该事件时忽略。
  }

  /**
   * 页面脚本注入行。桌面壳在启动时收集一次，所以必须同步注册；
   * 同一个表可能被根上下文和 webServer 作用域各触发一次，按行去重。
   */
  const pushInjectionRow = (table) => {
    try {
      if (!Array.isArray(table)) return
      for (const row of table) {
        if (!row) continue
        if (row.kind === 'script' && typeof row.text === 'string'
          && row.text.indexOf('/dsh-turn-notifier/client.js') >= 0) return
      }
      table.push({ kind: 'script', placement: 'body', text: INJECT_ROW_TEXT })
    } catch {
      // 注入失败不影响页面。
    }
  }

  try {
    ctx.on('webserver/index-inject', pushInjectionRow)
  } catch {
    // 非 Web 组合没有这个事件。
  }

  // 路由需要 webServer/connection 就绪；延迟到依赖可用后再注册。
  try {
    ctx.inject(['webServer'], (scope) => {
      try {
        // 事件也可能只在 webServer 作用域上派发（dsh web 的浏览器组合）。
        try {
          scope.on('webserver/index-inject', pushInjectionRow)
        } catch {
          // 忽略：根上下文已注册。
        }
        registerClientRoutes(scope, runtime, options)
      } catch (error) {
        try {
          ctx.logger?.warn?.('turn-notifier: could not register routes: %o', error)
        } catch {
          // 忽略
        }
      }
    })
  } catch {
    // 没有 webServer（如 TUI）时只保留原生通知。
  }

  const stateFor = (key) => {
    let state = turns.get(key)
    if (state === undefined) {
      state = { startedAt: undefined, turn: undefined, texts: [] }
      turns.set(key, state)
    }
    return state
  }

  try {
    ctx.on('session/event', (session, event) => {
      try {
        const type = event?.type
        const data = event?.data
        if (!type || !data) return
        const key = session?.id === undefined ? 'unknown' : session.id

        if (type === 'turn/start') {
          turns.set(key, { startedAt: Date.now(), turn: data.turn, texts: [] })
          return
        }

        if (type === 'assistant/message') {
          const text = textOfAssistantMessage(data.message)
          if (!text) return
          const state = stateFor(key)
          if (state.turn !== data.turn) {
            state.turn = data.turn
            state.texts = []
          }
          state.texts.push(text)
          // 只保留最近几段，避免长会话占内存。
          if (state.texts.length > 12) state.texts.splice(0, state.texts.length - 12)
          return
        }

        if (type !== 'turn/end') return

        const state = turns.get(key)
        turns.delete(key)

        const reason = data.reason ?? {}
        // 只提醒“正常完成”的轮次。
        if (reason.kind !== 'completed') return

        if (options.skipSubagents && session?.header?.origin === 'subagent') return

        const startedAt = state?.startedAt
        const elapsedSeconds = startedAt === undefined ? NaN : (Date.now() - startedAt) / 1000
        if (options.minSeconds > 0 && !(elapsedSeconds >= options.minSeconds)) return

        const sessionName = sessionTitleOf(ctx, session)
        const elapsed = formatElapsed(elapsedSeconds)

        // 摘要取本轮最后一段有内容的回答；没有正文时退回通用文案。
        const lastText = [...(state?.texts ?? [])].reverse().find((text) => text.trim()) ?? ''
        const summary = lastText ? shorten(stripMarkdown(lastText), options.summaryChars) : ''
        const body = summary || '本轮回答已完成'
        const subtitle = ['完成', elapsed].filter(Boolean).join(' · ')

        runtime.seq += 1
        runtime.last = {
          seq: runtime.seq,
          title: sessionName || options.title,
          subtitle,
          body,
          icon: options.iconPath ? ICON_ROUTE : undefined,
          sessionId: key,
          at: Date.now(),
        }

        const clientOnline = Date.now() - runtime.lastClientPollAt < CLIENT_HEARTBEAT_MS
        if (options.preferClient && clientOnline) {
          // 页面还开着：由页面内的 Notification 弹出（应用身份 + 图标），不重复发原生通知。
          logDelivery(options, { event: 'deliver', channel: 'client', title: runtime.last.title, subtitle, body })
          return
        }

        notifyNative(ctx, options, {
          title: runtime.last.title,
          subtitle,
          body,
          group: key,
        })
      } catch (error) {
        try {
          ctx?.logger?.warn?.('turn-notifier: handler failed: %o', error)
        } catch {
          // 忽略
        }
      }
    })
  } catch (error) {
    try {
      ctx?.logger?.warn?.('turn-notifier: could not subscribe: %o', error)
    } catch {
      // 忽略
    }
  }
}
