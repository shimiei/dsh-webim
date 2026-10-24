/**
 * dsh-webim — browser half.
 *
 * Adds one Settings section that shows the remote entry: a scannable QR code,
 * the copyable token URLs for every interface, and the controls to refresh the
 * token or pin the public address used by the QR code. All token and URL work
 * happens in the Host half over the `/webim` RPC channel.
 */
window.__ModuleLoader__.load({
  id: 'dsh-webim',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Shared RPC channel owned by this plugin's Host half. */
    const CHANNEL = '/webim'
    /** Locale namespace of this page. */
    const NS = 'webim'

    const zh = {
      section: '远程接入',
      title: '远程接入',
      sub: '用同一套 DeepSeek Harness 前端，从手机或另一台电脑操纵这台机器；本机路径留在本机。',
      loading: '读取入口信息…',
      running: '入口运行中',
      stopped: '入口未启动',
      disabled: '已整体关闭',
      disabledHint: '「远程接入总开关」关着：网关没有监听任何端口，公网和局域网都进不来。要恢复就把下面开关列表里的「远程接入总开关」重新打开。',
      publicOff: '「公网入口」已关闭：下面不再显示公网地址，隧道也会停。需要外网访问就先打开它。',
      noEntry: '局域网入口和公网入口都关掉了，没有任何可用的远程链接。',
      confirmDisable: '关掉总开关会让 3081 立刻停止监听：手机端页面会断开，隧道也会停，重新打开需要在这台电脑的 DSH 窗口里操作。确定关闭吗？',
      appliedCut: '已应用。当前连接可能随之断开，重新打开请在这台电脑的 DSH 窗口里操作。',
      masterSwitch: '总开关',
      modeTitle: '对外入口',
      modeLan: '仅局域网',
      modeLanHint: '同一 Wi-Fi 或同一网段的设备用 IP 直连，不暴露到公网。',
      modePublic: '公网直连',
      modePublicHint: '用你自己的公网 IP 或域名（端口映射 / 反向代理），下面填地址。',
      modeTunnel: 'Cloudflare 隧道',
      modeTunnelHint: '自动起一条 https 临时隧道，不用配端口映射；地址每次启动都会变。',
      lanAccess: '局域网可访问',
      lanAccessHint: '关掉后只监听 127.0.0.1，同网段设备连不上。',
      entriesTitle: '入口地址',
      entriesHint: '点一个设为扫码目标',
      qrTarget: '扫码目标',
      tokenTitle: '令牌',
      advanced: '更多选项',
      upstream: '上游',
      session: '登录有效期',
      days: '天',
      qrCaption: '用手机扫一扫，直接打开并自动登录',
      qrMissing: '暂时无法生成二维码，请复制下面的链接打开。',
      copy: '复制',
      copied: '已复制',
      open: '打开',
      refreshToken: '刷新令牌',
      refreshState: '刷新状态',
      refreshing: '正在刷新…',
      refreshHint: '刷新后，旧链接立即失效，已登录的浏览器也会被登出（需要重新扫码）。',
      confirmRefresh: '刷新令牌？旧链接、旧二维码会立刻作废，已经登录的浏览器同样会退出，需要用新链接重新进入。',
      tunnelTitle: 'Cloudflare 临时隧道',
      tunnelOn: '运行中',
      tunnelOff: '未开启',
      tunnelStart: '开启隧道',
      tunnelStop: '关闭隧道',
      tunnelBusy: '正在建立隧道…',
      tunnelHint: '自动下载并拉起 cloudflared 临时隧道，得到一个 https 公网地址（每次启动都会变，扫码即可用）。关掉隧道后地址立即失效。',
      tunnelFailed: '隧道启动失败',
      tunnelStarting: '正在建立隧道…',
      tunnelReady: '隧道已就绪，扫码即可访问。',
      tunnelAlsoPublic: '同时列出公网直连地址',
      tunnelAlsoPublicHint: '默认只用隧道；需要两个地址都在时再打开。',
      features: '功能开关',
      featuresHint: '关掉的功能会立即生效；这些开关保存在本机，不写进插件配置。',
      featureOn: '已开启',
      featureOff: '已关闭',
      resetFeatures: '恢复默认',
      pinPublic: '公网地址',
      pinPublicHint: '外网访问用的公网 IP 或域名（含端口）；留空则退回局域网地址。',
      save: '保存',
      detect: '自动检测',
      clear: '清除',
      saved: '已保存',
      detected: '已取到公网地址',
      tokenPinned: '令牌已由插件配置 accessToken 固定，删除该配置项后才能在这里刷新。',
      tokenMissing: '令牌尚未生成。',
      tokenRotated: '令牌已于',
      rotated: '刷新',
      error: '操作失败',
      unreachable: '读取失败：宿主插件没有响应。确认 dsh-webim 已安装并已重启应用。',
      details: '说明',
      explain: '这个入口不是端口转发：网关监听 0.0.0.0:3081，带令牌的链接会为浏览器签发正常会话，然后反向代理到本机正在运行的 Harness（同一套前端、会话和 WebSocket）。所有文件路径只在本机解释，远程看不到本地路径映射。',
    }
    const en = {
      section: 'Remote access',
      title: 'Remote access',
      sub: 'Drive this machine’s DeepSeek Harness from a phone or another computer through the same frontend; local paths stay local.',
      loading: 'Loading entry information…',
      running: 'entry running',
      stopped: 'entry stopped',
      disabled: 'switched off',
      disabledHint: 'The master switch is off: nothing is listening, so neither the LAN nor the internet can reach this machine. Turn the master switch back on to restore it.',
      publicOff: 'The public entry is off: no public address is shown and the tunnel is stopped. Turn it on for outside access.',
      noEntry: 'Both the LAN and public entries are off, so there is no remote link at all.',
      confirmDisable: 'Turning the master switch off stops the listener immediately: this page will drop and the tunnel stops. Re-enable it from the DSH window on this computer. Turn it off?',
      appliedCut: 'Applied. This connection may drop now; re-enable it from the DSH window on this computer.',
      masterSwitch: 'Master switch',
      modeTitle: 'Entry mode',
      modeLan: 'LAN only',
      modeLanHint: 'Reach it by IP from the same Wi-Fi or subnet; nothing is exposed to the internet.',
      modePublic: 'Public address',
      modePublicHint: 'Use your own public IP or domain (port forwarding / reverse proxy); fill it in below.',
      modeTunnel: 'Cloudflare tunnel',
      modeTunnelHint: 'Starts a temporary https tunnel automatically, no port forwarding needed; the address changes on every start.',
      lanAccess: 'LAN reachable',
      lanAccessHint: 'Off keeps the listener on 127.0.0.1 only; other devices cannot connect.',
      entriesTitle: 'Entry links',
      entriesHint: 'Pick the one the QR code should carry',
      qrTarget: 'QR target',
      tokenTitle: 'Token',
      advanced: 'More options',
      upstream: 'upstream',
      session: 'Session lifetime',
      days: 'd',
      qrCaption: 'Scan with your phone to open and sign in automatically',
      qrMissing: 'The QR code is unavailable right now; copy one of the links below.',
      copy: 'Copy',
      copied: 'Copied',
      open: 'Open',
      refreshToken: 'Refresh token',
      refreshState: 'Refresh status',
      refreshing: 'Refreshing…',
      refreshHint: 'Refreshing invalidates every old link at once and signs out the browsers that used it.',
      confirmRefresh: 'Refresh the token? Old links and QR codes stop working immediately, and browsers signed in through them are logged out; the new link is required.',
      tunnelTitle: 'Cloudflare quick tunnel',
      tunnelOn: 'running',
      tunnelOff: 'off',
      tunnelStart: 'Start tunnel',
      tunnelStop: 'Stop tunnel',
      tunnelBusy: 'Opening the tunnel…',
      tunnelHint: 'Downloads and runs a cloudflared quick tunnel automatically and yields an https public address (new on every start; scan and go). Stopping the tunnel kills the address immediately.',
      tunnelFailed: 'The tunnel failed to start',
      tunnelStarting: 'Opening the tunnel…',
      tunnelReady: 'The tunnel is up — scan to open it.',
      tunnelAlsoPublic: 'Also list the public address',
      tunnelAlsoPublicHint: 'Only the tunnel is used by default; turn this on when you want both.',
      features: 'Features',
      featuresHint: 'Switches apply immediately and are stored on this machine, not in the plugin config.',
      featureOn: 'on',
      featureOff: 'off',
      resetFeatures: 'Reset',
      pinPublic: 'Public address',
      pinPublicHint: 'The public IP or domain (with port) for outside access; leave it empty to fall back to the LAN address.',
      save: 'Save',
      detect: 'Detect',
      clear: 'Clear',
      saved: 'Saved',
      detected: 'Public address detected',
      tokenPinned: 'The token is pinned by the plugin config accessToken; clear it to rotate from here.',
      tokenMissing: 'No token has been generated yet.',
      tokenRotated: 'Token refreshed at',
      rotated: 'refreshed',
      error: 'Failed',
      unreachable: 'Could not load: the host plugin did not answer. Check that dsh-webim is installed and the app was restarted.',
      details: 'Details',
      explain: 'This entry is not port forwarding: the gateway listens on 0.0.0.0:3081, a token link issues a normal browser session, and every request is reverse-proxied to the Harness running on this machine (same frontend, sessions and WebSocket). Local paths are resolved locally and never mapped to the remote side.',
    }

    const CSS = `
.wb { display: grid; gap: 16px; width: 100%; max-width: 720px; min-width: 0; font-size: 13px; line-height: 1.6; color: inherit;
  --wb-accent: var(--color-blue-500, #4d6bfe);
  --wb-radius: var(--dsw-radius-md, 12px);
  --wb-radius-sm: var(--dsw-radius-sm, 8px);
  --wb-ease: var(--ds-ease-in-out, cubic-bezier(.4,0,.2,1));
  --wb-line: color-mix(in oklab, currentColor 14%, transparent);
  --wb-line-soft: color-mix(in oklab, currentColor 9%, transparent);
  --wb-surface: color-mix(in oklab, currentColor 3%, transparent);
  --wb-surface-hover: color-mix(in oklab, currentColor 6%, transparent);
  --wb-accent-soft: color-mix(in oklab, var(--wb-accent) 12%, transparent);
  --wb-accent-line: color-mix(in oklab, var(--wb-accent) 45%, transparent);
  --wb-ok: #18a058; --wb-warn: #d97706; --wb-err: #e5484d;
  --wb-mono: ui-monospace, SFMono-Regular, "Cascadia Code", Menlo, Consolas, monospace; }
.wb * { box-sizing: border-box; }
.wb-head { display: grid; gap: 3px; }
.wb-title { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: .01em; }
.wb-sub { margin: 0; font-size: 12.5px; opacity: .58; }
.wb-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--wb-line-soft);
  border-radius: var(--wb-radius); background: var(--wb-surface); }
.wb-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--wb-err); box-shadow: 0 0 0 3px color-mix(in oklab, var(--wb-err) 18%, transparent); }
.wb-dot.on { background: var(--wb-ok); box-shadow: 0 0 0 3px color-mix(in oklab, var(--wb-ok) 18%, transparent); }
.wb-bar-text { font-size: 12.5px; }
.wb-meta { font: 11.5px/1.5 var(--wb-mono); opacity: .55; word-break: break-all; }
.wb-grow { flex: 1 1 auto; min-width: 0; }
.wb-block { display: grid; gap: 10px; }
.wb-h { margin: 0; font-size: 11.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; opacity: .5; }
.wb-blockhead { display: flex; align-items: baseline; gap: 10px; }
.wb-hint { margin: 0; font-size: 11.5px; opacity: .55; }
.wb-seg { display: flex; gap: 2px; padding: 3px; border: 1px solid var(--wb-line); border-radius: var(--wb-radius-sm); background: var(--wb-surface); }
.wb-seg-item { appearance: none; flex: 1 1 0; min-width: 0; padding: 6px 10px; border: 0; border-radius: 6px; background: transparent; color: inherit;
  font: inherit; font-size: 12.5px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: background var(--ds-transition-duration, .2s) var(--wb-ease), color var(--ds-transition-duration, .2s) var(--wb-ease); }
.wb-seg-item:hover:not(.on) { background: var(--wb-surface-hover); }
.wb-seg-item.on { background: var(--wb-accent-soft); color: var(--wb-accent); font-weight: 500; box-shadow: inset 0 0 0 1px var(--wb-accent-line); }
.wb-seg-item:disabled { opacity: .45; cursor: default; }
.wb-grid { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 18px; align-items: start; }
.wb-cardlist { display: grid; gap: 8px; min-width: 0; }
.wb-entry { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 10px 12px;
  border: 1px solid var(--wb-line); border-radius: var(--wb-radius); background: transparent; color: inherit; text-align: left; font: inherit;
  cursor: pointer; transition: border-color var(--ds-transition-duration, .2s) var(--wb-ease), background var(--ds-transition-duration, .2s) var(--wb-ease); }
.wb-entry:hover { border-color: color-mix(in oklab, currentColor 24%, transparent); background: var(--wb-surface); }
.wb-entry.is-target { border-color: var(--wb-accent-line); background: var(--wb-accent-soft); }
.wb-entry.is-pending { border-style: dashed; cursor: default; grid-template-columns: auto minmax(0, 1fr); }
.wb-entry.is-pending:hover { background: transparent; border-color: var(--wb-line); }
.wb-radio { width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid color-mix(in oklab, currentColor 32%, transparent);
  display: grid; place-items: center; transition: border-color var(--ds-transition-duration, .2s) var(--wb-ease); }
.wb-entry.is-target .wb-radio { border-color: var(--wb-accent); }
.wb-radio::after { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--wb-accent); transform: scale(0); transition: transform var(--ds-transition-duration, .2s) var(--wb-ease); }
.wb-entry.is-target .wb-radio::after { transform: scale(1); }
.wb-entry-body { display: grid; gap: 2px; min-width: 0; }
.wb-entry-label { font-size: 12.5px; }
.wb-url { font: 11.5px/1.5 var(--wb-mono); word-break: break-all; opacity: .62; }
.wb-entry.is-target .wb-url { opacity: .78; }
.wb-entry-acts { display: flex; gap: 4px; flex: none; }
.wb-btn { appearance: none; font: inherit; font-size: 11.5px; flex: none; padding: 4px 9px; border-radius: 6px; border: 1px solid var(--wb-line);
  background: transparent; color: inherit; cursor: pointer; transition: background var(--ds-transition-duration, .2s) var(--wb-ease), border-color var(--ds-transition-duration, .2s) var(--wb-ease); }
.wb-btn:hover:not(:disabled) { background: var(--wb-surface-hover); border-color: color-mix(in oklab, currentColor 24%, transparent); }
.wb-btn.primary { background: var(--wb-accent); border-color: transparent; color: #fff; }
.wb-btn.primary:hover:not(:disabled) { filter: brightness(1.06); background: var(--wb-accent); }
.wb-btn:disabled { opacity: .45; cursor: default; }
.wb-qrbox { display: grid; gap: 7px; justify-items: center; width: 200px; }
.wb-qrcode { width: 190px; height: 190px; padding: 10px; border-radius: var(--wb-radius); background: #fff; box-shadow: 0 0 0 1px var(--wb-line-soft); }
.wb-qrcode svg { width: 100%; height: 100%; display: block; }
.wb-qr-missing { width: 190px; min-height: 120px; display: grid; place-items: center; padding: 12px; border-radius: var(--wb-radius);
  border: 1px dashed var(--wb-line); text-align: center; font-size: 11.5px; opacity: .6; }
.wb-qr-caption { margin: 0; font-size: 11.5px; opacity: .58; text-align: center; max-width: 200px; }
.wb-qr-caption b { font-weight: 500; opacity: .9; }
.wb-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.wb-note { margin: 0; font-size: 11.5px; opacity: .55; }
.wb-ok { color: var(--wb-ok); font-size: 12px; }
.wb-err { margin: 0; color: var(--wb-err); font-size: 12px; word-break: break-word; }
.wb-field { display: grid; gap: 8px; }
.wb-tunnel { display: grid; gap: 9px; padding: 10px 12px; border: 1px solid var(--wb-line-soft); border-radius: var(--wb-radius); background: var(--wb-surface); }
.wb-tunnel-head { display: flex; align-items: center; gap: 8px; }
.wb-tunnel-state { font-size: 12.5px; }
.wb-spin { width: 13px; height: 13px; flex: none; border-radius: 50%; display: inline-block;
  border: 2px solid color-mix(in oklab, currentColor 18%, transparent); border-top-color: var(--wb-accent);
  animation: wb-spin .8s linear infinite; }
@keyframes wb-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .wb-spin { animation-duration: 2.4s; } }
.wb-field > label { font-size: 12px; opacity: .6; }
.wb-input { width: 100%; padding: 7px 10px; border-radius: var(--wb-radius-sm); border: 1px solid var(--wb-line); background: transparent;
  color: inherit; font: 12px/1.5 var(--wb-mono); transition: border-color var(--ds-transition-duration, .2s) var(--wb-ease); }
.wb-input:focus { outline: none; border-color: var(--wb-accent); }
.wb-tg { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 12.5px; user-select: none; }
.wb-tg input { position: absolute; opacity: 0; width: 0; height: 0; }
.wb-tg-track { width: 32px; height: 18px; border-radius: 999px; background: color-mix(in oklab, currentColor 22%, transparent);
  display: inline-flex; align-items: center; padding: 2px; transition: background var(--ds-transition-duration, .2s) var(--wb-ease); }
.wb-tg-knob { width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform var(--ds-transition-duration, .2s) var(--wb-ease); }
.wb-tg.on .wb-tg-track { background: var(--wb-ok); }
.wb-tg.on .wb-tg-knob { transform: translateX(14px); }
.wb-tg input:disabled + .wb-tg-track { opacity: .45; }
.wb-tg input:focus-visible + .wb-tg-track { box-shadow: 0 0 0 2px var(--wb-accent-line); }
.wb-divider { height: 1px; background: var(--wb-line-soft); border: 0; margin: 2px 0; }
.wb-switches { display: grid; gap: 2px; }
.wb-switch { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 9px 2px; cursor: pointer;
  border-bottom: 1px solid var(--wb-line-soft); }
.wb-switch:last-of-type { border-bottom: 0; }
.wb-switch-body { display: grid; gap: 2px; min-width: 0; }
.wb-switch-label { font-size: 12.5px; }
.wb-switch-hint { font-size: 11.5px; opacity: .52; line-height: 1.5; }
.wb-switch input { appearance: none; flex: none; width: 32px; height: 18px; border-radius: 999px; margin: 2px 0 0;
  background: color-mix(in oklab, currentColor 22%, transparent); position: relative; cursor: pointer;
  transition: background var(--ds-transition-duration, .2s) var(--wb-ease); }
.wb-switch input::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff;
  transition: transform var(--ds-transition-duration, .2s) var(--wb-ease); }
.wb-switch input:checked { background: var(--wb-ok); }
.wb-switch input:checked::after { transform: translateX(14px); }
.wb-switch input:disabled { opacity: .45; cursor: default; }
.wb-fold > summary { list-style: none; cursor: pointer; font-size: 12px; opacity: .6; user-select: none; padding: 2px 0; }
.wb-fold > summary::-webkit-details-marker { display: none; }
.wb-fold > summary::before { content: '▸'; display: inline-block; width: 14px; font-size: 10px; transition: transform var(--ds-transition-duration, .2s) var(--wb-ease); }
.wb-fold[open] > summary::before { transform: rotate(90deg); }
.wb-fold > summary:hover { opacity: .85; }
.wb-fold-body { display: grid; gap: 10px; padding-top: 10px; }
.wb-empty { display: grid; gap: 6px; padding: 18px; border: 1px dashed var(--wb-line); border-radius: var(--wb-radius); }
@media (max-width: 640px) {
  .wb-grid { grid-template-columns: minmax(0, 1fr); }
  .wb-qrbox { width: 100%; order: -1; }
  .wb-qrcode { width: 168px; height: 168px; }
  .wb-qr-missing { width: 168px; }
  .wb-seg-item { font-size: 12px; padding: 6px 8px; }
  .wb-bar { row-gap: 8px; }
  .wb-meta { flex: 1 1 100%; order: 3; }
}`

    /** Copy text to the clipboard, falling back to a hidden textarea. */
    async function copyText(text) {
      try {
        if (navigator.clipboard && window.isSecureContext !== false) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // fall through to the legacy path
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch {
        return false
      }
    }

    function formatTime(value) {
      if (!value) return ''
      try {
        return new Date(value).toLocaleString()
      } catch {
        return ''
      }
    }

    /**
     * One settings section: QR entry, token URLs, token refresh and public address.
     * @param {{ t: Function, rpcCall: Function }} props - injected faces from the registration.
     */
    function RemoteAccessSettings(props) {
      const t = props.t
      const rpcCall = props.rpcCall
      const [info, setInfo] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState('')
      const [copiedId, setCopiedId] = React.useState('')
      const [message, setMessage] = React.useState('')
      const [publicInput, setPublicInput] = React.useState('')
      const [publicTouched, setPublicTouched] = React.useState(false)
      const [tunnelElapsed, setTunnelElapsed] = React.useState(0)
      const [tunnelPending, setTunnelPending] = React.useState(false)
      const watchingRef = React.useRef(false)
      const cancelWatchRef = React.useRef(false)

      const applyResult = React.useCallback((result) => {
        if (result && result.ok === true) {
          setInfo(result.value)
          setError(null)
          return true
        }
        const message = result && result.error && result.error.message ? String(result.error.message) : t('unreachable')
        setError(message)
        return false
      }, [t])

      const load = React.useCallback(async () => {
        setLoading(true)
        try {
          const result = await rpcCall('info', {})
          applyResult(result)
        } catch (failure) {
          setError(describeFailure(failure))
        } finally {
          setLoading(false)
        }
      }, [applyResult, rpcCall, t])

      React.useEffect(() => {
        void load()
      }, [load])

      React.useEffect(() => {
        if (!info || publicTouched) return
        setPublicInput(info.publicAddress?.saved || '')
      }, [info, publicTouched])

      /** Turn a thrown RPC failure into a message that names the real cause. */
      function describeFailure(failure) {
        const text = failure && typeof failure === 'object' && 'message' in failure ? String(failure.message) : String(failure ?? '')
        const trimmed = text.trim().slice(0, 160)
        return trimmed === '' || trimmed === 'undefined' ? t('unreachable') : `${t('unreachable')}（${trimmed}）`
      }

      async function run(label, endpoint, payload) {
        setBusy(label)
        setMessage('')
        setError(null)
        try {
          const result = await rpcCall(endpoint, payload || {})
          if (applyResult(result)) {
            if (endpoint === 'refresh') setMessage(`${t('tokenRotated')} ${formatTime(result.value?.access?.rotatedAt)}`)
            else if (endpoint === 'detectPublicUrl') setMessage(t('detected'))
            else if (endpoint === 'setPublicUrl') setMessage(t('saved'))
          }
        } catch (failure) {
          setError(describeFailure(failure))
        } finally {
          setBusy('')
        }
      }

      async function refreshToken() {
        if (!window.confirm(t('confirmRefresh'))) return
        await run('refresh', 'refresh', {})
      }

      async function savePublic() {
        setPublicTouched(false)
        await run('public', 'setPublicUrl', { url: publicInput.trim() })
      }

      async function clearPublic() {
        setPublicTouched(false)
        setPublicInput('')
        await run('public', 'setPublicUrl', { url: '' })
      }

      async function copy(id, text) {
        const ok = await copyText(text)
        if (!ok) {
          setMessage(text)
          return
        }
        setCopiedId(id)
        setMessage('')
        window.setTimeout(() => setCopiedId((current) => (current === id ? '' : current)), 1600)
      }

      const access = info?.access
      const urls = access?.urls ?? []
      const gateway = info?.gateway
      const featureDefs = info?.features?.defs ?? []
      const featureValues = info?.features?.values ?? {}
      const qr = access?.qr
      const ttlDays = gateway?.sessionDays
      const disabled = gateway?.disabled === true
      const reach = info?.reach ?? { lan: true, public: true, tunnel: false }

      const CUTTING_KEYS = new Set(['enabled', 'lan'])

      async function toggleFeature(key, enabled) {
        if (key === 'enabled' && !enabled && !window.confirm(t('confirmDisable'))) return
        const mayCut = CUTTING_KEYS.has(key) && !enabled
        if (mayCut) applyReach({ [key]: enabled })
        await run(`feat-${key}`, 'setFeatures', { features: { [key]: enabled } })
        if (mayCut) {
          // The request reached the host and the switch was stored; only the
          // reply was lost with the connection, so do not alarm the owner.
          setError(null)
          setMessage(t('appliedCut'))
        }
        // Rebinding the listener happens just after the reply (draining live
        // sockets takes a moment), so poll until the entry answers again.
        void refreshAfterRebind()
      }

      /**
       * Reach switches are driven by the mode control, not by the switch list.
       * The public address and the tunnel are separate entries: a quick tunnel
       * already gives a reachable https URL, so choosing it turns the public
       * address off (the "both" case is the toggle inside the tunnel block).
       */
      const MODE_DEFS = [
        { id: 'lan', label: t('modeLan'), hint: t('modeLanHint'), patch: { lan: true, public: false, tunnel: false } },
        { id: 'public', label: t('modePublic'), hint: t('modePublicHint'), patch: { lan: true, public: true, tunnel: false } },
        { id: 'tunnel', label: t('modeTunnel'), hint: t('modeTunnelHint'), patch: { lan: true, public: false, tunnel: true } },
      ]
      const mode = featureValues.tunnel === true ? 'tunnel' : featureValues.public === true ? 'public' : 'lan'
      const modeDef = MODE_DEFS.find((def) => def.id === mode) ?? MODE_DEFS[0]
      const enabledOn = disabled !== true
      const advancedDefs = featureDefs.filter((def) => !['enabled', 'lan', 'public', 'tunnel'].includes(def.key))
      const qrTargetLabel = urls.find((entry) => entry.isQrTarget)?.label ?? ''
      const publicOn = featureValues.public === true && enabledOn
      const tunnelState = info?.tunnel ?? {}
      const tunnelBusy = busy === 'tunnel' || tunnelPending || tunnelState.starting === true

      /** Mirror a reach patch locally so the panel answers before the listener settles. */
      function applyReach(next) {
        setInfo((current) => {
          if (!current) return current
          const values = { ...current.features.values, ...next }
          const on = values.enabled === true
          const reach = { lan: on && values.lan === true, public: on && values.public === true, tunnel: on && values.tunnel === true }
          const keep = (entry) => {
            if (entry.kind === 'lan') return reach.lan
            if (entry.kind === 'public') return reach.public
            if (entry.kind === 'tunnel') return reach.tunnel
            return true
          }
          const urls = (current.access?.urls ?? []).filter(keep)
          const target = urls.find((entry) => entry.id === current.access?.qrTargetId) ?? urls[0]
          return {
            ...current,
            gateway: { ...current.gateway, disabled: !on, running: on ? current.gateway?.running === true : false },
            features: { ...current.features, values },
            reach,
            access: {
              ...current.access,
              urls: urls.map((entry) => ({ ...entry, isQrTarget: entry.id === target?.id })),
              qrTargetId: target?.id ?? '',
              primaryId: target?.id ?? '',
              qr: urls.length > 0 ? current.access?.qr ?? null : null,
            },
          }
        })
      }

      /**
       * A reach change can close or rebind the very port this page talks through,
       * so the reply may never arrive. Poll until the entry answers again; give
       * up quietly when it was switched off on purpose.
       */
      async function refreshAfterRebind(tries = 5) {
        for (let attempt = 0; attempt < tries; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 1200))
          try {
            const result = await rpcCall('info', {})
            if (applyResult(result)) return true
          } catch {
            // still rebinding, or switched off
          }
        }
        return false
      }

      async function setMode(id) {
        const def = MODE_DEFS.find((item) => item.id === id)
        if (!def || id === mode || busy !== '') return
        applyReach(def.patch)
        await run('mode', 'setFeatures', { features: def.patch })
        // Every mode change rebinds the listener, so the reply often dies with it.
        setError(null)
        void refreshAfterRebind()
        // Entering tunnel mode starts cloudflared in the background: follow it so
        // the panel shows a live progress state instead of a frozen button.
        if (def.patch.tunnel === true) {
          setTunnelElapsed(1)
          void watchTunnel()
        }
      }

      /** Choosing an entry is what decides the QR content. */
      async function pickQrTarget(entry) {
        if (busy !== '' || entry.isQrTarget) return
        await run('target', 'setQrTarget', { id: entry.id })
      }

      /**
       * `tunnelStart` replies as soon as the attempt is queued, because fetching
       * cloudflared and waiting for a hostname can take 20 s. Keep polling
       * `info` so the panel shows a live timer instead of a silent button.
       * `starting: false` alone is not a stop condition — the host queues the
       * spawn, so the flag can still be false right after the click.
       */
      async function watchTunnel(deadlineMs = 180000) {
        if (watchingRef.current) return
        watchingRef.current = true
        setTunnelPending(true)
        setTunnelElapsed(1)
        setMessage('')
        cancelWatchRef.current = false
        const began = Date.now()
        let idle = 0
        try {
          for (;;) {
            await new Promise((resolve) => window.setTimeout(resolve, 1000))
            if (cancelWatchRef.current) break
            setTunnelElapsed(Math.round((Date.now() - began) / 1000))
            try {
              const result = await rpcCall('info', {})
              if (applyResult(result)) {
                const state = result.value?.tunnel ?? {}
                // `running` alone is not enough: the child is alive before it has
                // published a hostname, and that phase is still "starting".
                if (state.running === true && state.starting !== true) {
                  setMessage(t('tunnelReady'))
                  break
                }
                if (state.error) break
                // Give the host a few seconds of grace before concluding that
                // nothing is going to happen.
                idle = state.starting === true ? 0 : idle + 1
                if (idle >= 6) break
              }
            } catch {
              // the panel reconnects on its own; keep trying until the deadline
            }
            if (Date.now() - began > deadlineMs) break
          }
        } finally {
          watchingRef.current = false
          setTunnelPending(false)
          setTunnelElapsed(0)
        }
      }

      async function tunnelAction() {
        const running = info?.tunnel?.running === true
        // Stopping must end the progress state now, not when the watcher's grace
        // window runs out: a requested stop is not a start that is still working.
        if (running) cancelWatchRef.current = true
        setTunnelElapsed(1)
        await run('tunnel', running ? 'tunnelStop' : 'tunnelStart', {})
        if (!running) void watchTunnel()
        else {
          setTunnelPending(false)
          setTunnelElapsed(0)
        }
      }

      return h('section', { className: 'wb' },
        h('style', null, CSS),
        h('header', { className: 'wb-head' },
          h('h2', { className: 'wb-title' }, t('title')),
          h('p', { className: 'wb-sub' }, t('sub')),
        ),
        h('div', { className: 'wb-bar' },
          h('span', { className: `wb-dot${enabledOn ? (gateway?.running ? ' on' : '') : ''}` }),
          h('span', { className: 'wb-bar-text' }, disabled ? t('disabled') : gateway?.running ? t('running') : t('stopped')),
          gateway && !disabled ? h('span', { className: 'wb-meta' }, `${gateway.host}:${gateway.port}`) : null,
          h('span', { className: 'wb-grow' }),
          h('button', {
            type: 'button',
            className: 'wb-btn',
            disabled: busy !== '',
            onClick: () => void run('reload', 'info', {}),
            title: t('refreshState'),
          }, t('refreshState')),
          h('label', { className: `wb-tg${enabledOn ? ' on' : ''}` },
            h('input', {
              type: 'checkbox',
              checked: enabledOn,
              disabled: busy !== '',
              onChange: (event) => void toggleFeature('enabled', event.target.checked),
            }),
            h('span', { className: 'wb-tg-track' }, h('span', { className: 'wb-tg-knob' })),
            h('span', null, t('masterSwitch')),
          ),
        ),
        error !== null ? h('p', { className: 'wb-err' }, `${t('error')}：${error}`) : null,
        message !== '' ? h('p', { className: 'wb-ok' }, message) : null,
        loading
          ? h('p', { className: 'wb-sub' }, t('loading'))
          : disabled
            ? h('div', { className: 'wb-empty' }, h('p', { className: 'wb-note' }, t('disabledHint')))
            : h(React.Fragment, null,
              h('section', { className: 'wb-block' },
                h('div', { className: 'wb-blockhead' },
                  h('h3', { className: 'wb-h' }, t('modeTitle')),
                  h('span', { className: 'wb-grow' }),
                  // LAN-only mode implies LAN access, so the switch would only
                  // show a frozen "on" state; it appears in the other two modes.
                  mode === 'lan' ? null : h('label', { className: `wb-tg${reach.lan ? ' on' : ''} wb-bar-text`, title: t('lanAccessHint') },
                    h('input', {
                      type: 'checkbox',
                      checked: reach.lan === true,
                      disabled: busy !== '',
                      onChange: (event) => void toggleFeature('lan', event.target.checked),
                    }),
                    h('span', { className: 'wb-tg-track' }, h('span', { className: 'wb-tg-knob' })),
                    h('span', null, t('lanAccess')),
                  ),
                ),
                h('div', { className: 'wb-seg', role: 'radiogroup', 'aria-label': t('modeTitle') },
                  ...MODE_DEFS.map((def) => h('button', {
                    type: 'button',
                    key: def.id,
                    role: 'radio',
                    'aria-checked': mode === def.id,
                    className: `wb-seg-item${mode === def.id ? ' on' : ''}`,
                    disabled: busy !== '',
                    onClick: () => void setMode(def.id),
                  }, def.label)),
                ),
                h('p', { className: 'wb-hint' }, modeDef.hint),
                publicOn ? h('div', { className: 'wb-field' },
                  h('label', { htmlFor: 'wb-public-url' }, t('pinPublic')),
                  h('div', { className: 'wb-actions' },
                    h('input', {
                      id: 'wb-public-url',
                      className: 'wb-input wb-grow',
                      value: publicInput,
                      placeholder: 'http://1.2.3.4:3081',
                      spellCheck: false,
                      onChange: (event) => {
                        setPublicTouched(true)
                        setPublicInput(event.target.value)
                      },
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') void savePublic()
                      },
                    }),
                    h('button', { type: 'button', className: 'wb-btn primary', disabled: busy !== '', onClick: () => void savePublic() }, t('save')),
                    h('button', { type: 'button', className: 'wb-btn', disabled: busy !== '', onClick: () => void run('detect', 'detectPublicUrl', {}) }, busy === 'detect' ? '…' : t('detect')),
                    info?.publicAddress?.saved ? h('button', { type: 'button', className: 'wb-btn', disabled: busy !== '', onClick: () => void clearPublic() }, t('clear')) : null,
                  ),
                  h('p', { className: 'wb-note' }, t('pinPublicHint')),
                ) : null,
                mode === 'tunnel' ? h('div', { className: 'wb-tunnel' },
                  h('div', { className: 'wb-tunnel-head' },
                    tunnelBusy
                      ? h('span', { className: 'wb-spin', 'aria-hidden': 'true' })
                      : h('span', { className: `wb-dot${tunnelState.running ? ' on' : ''}` }),
                    h('span', { className: 'wb-tunnel-state' },
                      tunnelBusy ? t('tunnelStarting') : tunnelState.running ? t('tunnelOn') : t('tunnelOff')),
                    tunnelBusy ? h('span', { className: 'wb-meta' }, `${tunnelElapsed}s`) : null,
                    h('span', { className: 'wb-grow' }),
                    h('button', {
                      type: 'button',
                      className: `wb-btn${tunnelState.running || tunnelBusy ? '' : ' primary'}`,
                      disabled: busy !== '' && !tunnelBusy,
                      onClick: () => void tunnelAction(),
                    }, tunnelBusy ? t('tunnelStop') : tunnelState.running ? t('tunnelStop') : t('tunnelStart')),
                  ),
                  tunnelState.running && tunnelState.url
                    ? h('div', { className: 'wb-actions' },
                      h('code', { className: 'wb-url wb-grow' }, tunnelState.url),
                      h('button', {
                        type: 'button',
                        className: 'wb-btn',
                        onClick: () => void copy('tunnel', tunnelState.url),
                      }, copiedId === 'tunnel' ? t('copied') : t('copy')),
                    )
                    : null,
                  tunnelState.error ? h('p', { className: 'wb-err' }, `${t('tunnelFailed')}：${tunnelState.error}`) : null,
                  h('label', { className: `wb-tg${publicOn ? ' on' : ''} wb-bar-text` },
                    h('input', {
                      type: 'checkbox',
                      checked: publicOn,
                      disabled: busy !== '',
                      onChange: (event) => void toggleFeature('public', event.target.checked),
                    }),
                    h('span', { className: 'wb-tg-track' }, h('span', { className: 'wb-tg-knob' })),
                    h('span', null, t('tunnelAlsoPublic')),
                  ),
                  h('p', { className: 'wb-note' }, t('tunnelAlsoPublicHint')),
                  h('p', { className: 'wb-note' }, t('tunnelHint')),
                ) : null,
              ),
              h('hr', { className: 'wb-divider' }),
              h('section', { className: 'wb-block' },
                h('div', { className: 'wb-blockhead' },
                  h('h3', { className: 'wb-h' }, t('entriesTitle')),
                  h('span', { className: 'wb-hint' }, t('entriesHint')),
                ),
                urls.length === 0
                  ? h('div', { className: 'wb-empty' }, h('p', { className: 'wb-note' }, t('noEntry')))
                  : h('div', { className: 'wb-grid' },
                    h('div', { className: 'wb-cardlist' },
                      mode === 'tunnel' && tunnelBusy && !urls.some((entry) => entry.kind === 'tunnel')
                        ? h('div', { className: 'wb-entry is-pending', 'aria-live': 'polite' },
                          h('span', { className: 'wb-spin', 'aria-hidden': 'true' }),
                          h('span', { className: 'wb-entry-body' },
                            h('span', { className: 'wb-entry-label' }, t('modeTunnel')),
                            h('span', { className: 'wb-url' }, `${t('tunnelStarting')} ${tunnelElapsed}s`),
                          ),
                        )
                        : null,
                      ...urls.map((entry) => h('div', {
                        key: entry.id,
                        className: `wb-entry${entry.isQrTarget ? ' is-target' : ''}`,
                        role: 'radio',
                        'aria-checked': entry.isQrTarget === true,
                        tabIndex: 0,
                        onClick: () => void pickQrTarget(entry),
                        onKeyDown: (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            void pickQrTarget(entry)
                          }
                        },
                      },
                        h('span', { className: 'wb-radio' }),
                        h('span', { className: 'wb-entry-body' },
                          h('span', { className: 'wb-entry-label' }, entry.label),
                          h('span', { className: 'wb-url' }, entry.url),
                        ),
                        h('span', { className: 'wb-entry-acts' },
                          h('button', {
                            type: 'button',
                            className: 'wb-btn',
                            title: entry.tokenUrl,
                            onClick: (event) => {
                              event.stopPropagation()
                              void copy(entry.id, entry.tokenUrl)
                            },
                          }, copiedId === entry.id ? t('copied') : t('copy')),
                          h('a', {
                            className: 'wb-btn',
                            href: entry.tokenUrl,
                            target: '_blank',
                            rel: 'noreferrer',
                            onClick: (event) => event.stopPropagation(),
                          }, t('open')),
                        ),
                      )),
                    ),
                    h('div', { className: 'wb-qrbox' },
                      qr && qr.svg
                        ? h('div', { className: 'wb-qrcode', dangerouslySetInnerHTML: { __html: qr.svg } })
                        : h('div', { className: 'wb-qr-missing' }, t('qrMissing')),
                      h('p', { className: 'wb-qr-caption' }, qr && qr.svg
                        ? h(React.Fragment, null, t('qrTarget'), ' · ', h('b', null, qrTargetLabel))
                        : t('qrCaption')),
                    ),
                  ),
              ),
              h('hr', { className: 'wb-divider' }),
              h('section', { className: 'wb-block' },
                h('div', { className: 'wb-blockhead' },
                  h('h3', { className: 'wb-h' }, t('tokenTitle')),
                  h('span', { className: 'wb-hint' }, `${t('session')} ${ttlDays || '—'} ${t('days')}`),
                  h('span', { className: 'wb-grow' }),
                  h('button', {
                    type: 'button',
                    className: 'wb-btn',
                    disabled: busy !== '' || access?.tokenConfigured === true,
                    onClick: () => void refreshToken(),
                    title: access?.tokenConfigured === true ? t('tokenPinned') : t('refreshHint'),
                  }, busy === 'refresh' ? t('refreshing') : t('refreshToken')),
                ),
                access?.tokenConfigured ? h('p', { className: 'wb-note' }, t('tokenPinned')) : h('p', { className: 'wb-note' }, t('refreshHint')),
              ),
              h('details', { className: 'wb-fold' },
                h('summary', null, t('advanced')),
                h('div', { className: 'wb-fold-body' },
                  h('div', { className: 'wb-blockhead' },
                    h('span', { className: 'wb-hint' }, t('features')),
                    h('span', { className: 'wb-grow' }),
                    h('button', {
                      type: 'button',
                      className: 'wb-btn',
                      disabled: busy !== '',
                      onClick: () => void run('features', 'resetFeatures', {}),
                    }, t('resetFeatures')),
                  ),
                  h('div', { className: 'wb-switches' },
                    ...advancedDefs.map((def) => h('label', { className: 'wb-switch', key: def.key },
                      h('span', { className: 'wb-switch-body' },
                        h('span', { className: 'wb-switch-label' }, def.label),
                        h('span', { className: 'wb-switch-hint' }, def.hint),
                      ),
                      h('input', {
                        type: 'checkbox',
                        checked: featureValues[def.key] === true,
                        disabled: busy !== '',
                        onChange: (event) => void toggleFeature(def.key, event.target.checked),
                      }),
                    )),
                  ),
                  h('p', { className: 'wb-note' }, t('featuresHint')),
                  h('p', { className: 'wb-note' }, t('explain')),
                ),
              ),
            ),
      )
    }

    return {
      name: 'dsh-webim',
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        const rpcCall = (endpoint, payload) => ctx.connection.rpc.call(CHANNEL, endpoint, payload)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-webim: locale dictionaries')
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-webim',
          order: 80,
          label: () => t('section'),
          inject: () => ({ t, rpcCall }),
        }, RemoteAccessSettings))
      },
    }
  },
})
