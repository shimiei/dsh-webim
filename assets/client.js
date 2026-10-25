/* dsh-webim client add-on — injected into the DSH web shell by the gateway.
 *
 * The Harness frontend is reused unchanged; this script only adds the pieces a
 * remote browser needs and a local one does not:
 *   - a small floating entry pill (status / file browser / logout)
 *   - conversion of local absolute paths and file:// links into the gateway's
 *     /__webim/fs view, so links that only exist on this machine still work
 *     for the remote viewer.
 */
(() => {
  'use strict'
  if (window.__DSH_WEBIM_CLIENT__) return
  window.__DSH_WEBIM_CLIENT__ = true

  const BASE = '/__webim'
  const state = { status: null, features: null, mobile: null, linkifying: false, observer: null }

  // `theme` keeps the standalone file-browser page on the same palette as the
  // shell it was opened from, instead of following the operating system.
  const fsUrl = (localPath) => `${BASE}/fs?path=${encodeURIComponent(localPath)}&theme=${currentTheme()}`

  // ---- theme ---------------------------------------------------------------
  // The Harness owns the light/dark choice and publishes it as `color-scheme`
  // on <html>. A shadow root does not inherit that, so the value is mirrored
  // onto an attribute that both this stylesheet and the shadow markup key on.
  // Without it the floating pill stayed dark inside a light app.
  function currentTheme() {
    const scheme = getComputedStyle(document.documentElement).colorScheme || ''
    if (/dark/iu.test(scheme)) return 'dark'
    if (/light/iu.test(scheme)) return 'light'
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    return media?.matches ? 'dark' : 'light'
  }

  function syncTheme() {
    const theme = currentTheme()
    if (document.documentElement.dataset.webimTheme !== theme) {
      document.documentElement.dataset.webimTheme = theme
    }
    const host = document.getElementById('dsh-webim-entry')
    if (host && host.dataset.theme !== theme) host.dataset.theme = theme
  }

  function watchTheme() {
    syncTheme()
    const observer = new MutationObserver(syncTheme)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-ds-theme', 'data-ds-theme-source'],
    })
    window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', syncTheme)
  }

  function toast(message) {
    let el = document.querySelector('.dsh-webim-toast')
    if (!el) {
      el = document.createElement('div')
      el.className = 'dsh-webim-toast'
      document.body.appendChild(el)
    }
    el.textContent = message
    el.classList.add('show')
    clearTimeout(el.__hideTimer)
    el.__hideTimer = setTimeout(() => el.classList.remove('show'), 2600)
  }

  function openPath(localPath) {
    const target = fsUrl(localPath)
    const win = window.open(target, '_blank', 'noopener')
    if (!win) {
      toast('浏览器拦截了新窗口，请允许弹出窗口后重试')
      location.assign(target)
    }
  }

  /** Convert a link target or Windows path text into a local absolute path. */
  function fileUrlToPath(value) {
    if (typeof value !== 'string') return ''
    const href = value.trim()
    if (href === '') return ''
    if (/^file:/iu.test(href) || /^(dsh-file|dsh|vscode-file):/iu.test(href)) {
      try {
        const url = new URL(href)
        let pathname = decodeURIComponent(url.pathname || '')
        if (url.hostname && url.hostname !== 'localhost') {
          return `\\\\${url.hostname}${pathname.replaceAll('/', '\\')}`
        }
        if (/^\/[A-Za-z]:\//u.test(pathname)) pathname = pathname.slice(1)
        const local = pathname.replaceAll('/', '\\')
        return local === '' ? '' : local
      } catch {
        return ''
      }
    }
    if (/^[A-Za-z]:[\\/]/u.test(href)) return href
    return ''
  }

  // ---------------------------------------------------------------------------
  // Local-path linkification
  // ---------------------------------------------------------------------------

  const PATH_RE = /(^|[\s([{"'`=:：,;，；])([A-Za-z]:[\\/][^\s<>"|?*\r\n]{1,400})/gu
  const TRAILING = /[.,;:!?)\]}"'”’。，；：！？、]+$/u

  function trimPath(raw) {
    let value = raw.replace(TRAILING, '')
    // Keep a trailing separator when the path intentionally denotes a folder.
    if (value.endsWith('\\') || value.endsWith('/')) value = value.slice(0, -1)
    return value
  }

  function linkifyTextNode(node) {
    const text = node.nodeValue
    if (!text || text.length < 4 || !/[A-Za-z]:[\\/]/u.test(text)) return
    const parent = node.parentElement
    if (!parent) return
    if (parent.closest('a,textarea,input,select,option,script,style,[contenteditable="true"],#dsh-webim-entry')) return

    let match
    let last = 0
    let changed = false
    const fragment = document.createDocumentFragment()
    PATH_RE.lastIndex = 0
    while ((match = PATH_RE.exec(text)) !== null) {
      const raw = match[2]
      const local = trimPath(raw)
      if (local.length < 4 || !/^[A-Za-z]:[\\/]/u.test(local)) continue
      const start = match.index + match[1].length
      const end = start + raw.length
      if (start > last) fragment.appendChild(document.createTextNode(text.slice(last, start)))
      const link = document.createElement('a')
      link.className = 'dsh-webim-path'
      link.href = fsUrl(local)
      link.title = `在远程浏览器中打开：${local}（本机文件）`
      link.textContent = raw
      link.target = '_blank'
      link.rel = 'noopener'
      fragment.appendChild(link)
      changed = true
      last = end
    }
    if (!changed) return
    if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)))
    node.parentNode.replaceChild(fragment, node)
  }

  function walkAndLinkify(root, budget) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.length < 4) return NodeFilter.FILTER_REJECT
        if (!/[A-Za-z]:[\\/]/u.test(node.nodeValue)) return NodeFilter.FILTER_REJECT
        const parent = node.parentElement
        if (!parent) return NodeFilter.FILTER_REJECT
        if (parent.closest('a,textarea,input,select,option,script,style,[contenteditable="true"],#dsh-webim-entry')) {
          return NodeFilter.FILTER_REJECT
        }
        return NodeFilter.FILTER_ACCEPT
      },
    })
    let seen = 0
    while (walker.nextNode() !== null) {
      linkifyTextNode(walker.currentNode)
      seen += 1
      if (seen > budget) break
    }
  }

  function startLinkify() {
    if (state.linkifying) return
    state.linkifying = true
    const queue = new Set()
    let scheduled = false

    const run = () => {
      scheduled = false
      if (!document.body) return
      const nodes = [...queue]
      queue.clear()
      for (const node of nodes.slice(0, 40)) {
        if (!node.isConnected) continue
        if (node.nodeType === Node.TEXT_NODE) linkifyTextNode(node)
        else if (node.nodeType === Node.ELEMENT_NODE) walkAndLinkify(node, 400)
      }
      if (queue.size > 0) schedule()
    }
    const schedule = () => {
      if (scheduled) return
      scheduled = true
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 900 })
      else setTimeout(run, 250)
    }

    const observe = (root) => {
      if (!root || state.observer) return
      state.observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE) {
              if (node.nodeType === Node.ELEMENT_NODE && node.id === 'dsh-webim-entry') continue
              queue.add(node)
            }
          }
        }
        if (queue.size > 0) schedule()
      })
      state.observer.observe(root, { childList: true, subtree: true })
      walkAndLinkify(root, 3000)
    }

    if (document.body) observe(document.body)
    else document.addEventListener('DOMContentLoaded', () => observe(document.body), { once: true })
  }

  // ---------------------------------------------------------------------------
  // Link interception (file://, dsh-file://, bare Windows paths)
  // ---------------------------------------------------------------------------

  document.addEventListener(
    'click',
    (event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : []
      for (const node of path) {
        if (!node || node.tagName !== 'A') continue
        const raw = node.getAttribute('href') || node.getAttribute('data-href') || ''
        const local = fileUrlToPath(raw)
        if (local !== '') {
          event.preventDefault()
          event.stopPropagation()
          openPath(local)
        }
        return
      }
    },
    true,
  )

  const rawWindowOpen = window.open.bind(window)
  window.open = function patchedOpen(url, ...rest) {
    const local = fileUrlToPath(url)
    if (local !== '') return rawWindowOpen(fsUrl(local), ...rest)
    return rawWindowOpen(url, ...rest)
  }

  // ---------------------------------------------------------------------------
  // Floating entry pill (shadow DOM so Harness styles cannot reach it)
  // ---------------------------------------------------------------------------

  function createPill() {
    if (document.getElementById('dsh-webim-entry')) return
    const host = document.createElement('div')
    host.id = 'dsh-webim-entry'
    host.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483000;'
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = `
      <style>
        :host { all: initial; }
        /* Light is the default; :host([data-theme="dark"]) flips the palette.
           Every colour below goes through a variable so the pill never ends up
           dark-on-dark or light-on-light. */
        .wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
          font: 12px/1.4 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
          --pill-bg: rgba(255, 255, 255, .9); --pill-fg: #1f2126; --pill-ring: rgba(16, 24, 40, .1);
          --pill-name-hover: #3350e6; --pill-shadow: 0 8px 24px rgba(16, 24, 40, .16), 0 1px 3px rgba(16, 24, 40, .1);
          --btn-bg: rgba(16, 24, 40, .06); --btn-fg: #2c2f36;
          --panel-bg: rgba(255, 255, 255, .97); --panel-fg: #1b1d22;
          --muted-fg: #64707f; --warn-bg: rgba(217, 119, 6, .12); --warn-fg: #92400e;
          --panel-shadow: 0 16px 40px rgba(16, 24, 40, .18), 0 2px 6px rgba(16, 24, 40, .08); }
        :host([data-theme="dark"]) .wrap {
          --pill-bg: rgba(23, 24, 28, .9); --pill-fg: #f2f3f5; --pill-ring: rgba(255, 255, 255, .08);
          --pill-name-hover: #9db2ff; --pill-shadow: 0 8px 24px rgba(0, 0, 0, .28), 0 1px 3px rgba(0, 0, 0, .3);
          --btn-bg: rgba(255, 255, 255, .07); --btn-fg: #dfe3ec;
          --panel-bg: rgba(23, 24, 28, .96); --panel-fg: #e9ebf0;
          --muted-fg: #9aa0aa; --warn-bg: rgba(255, 159, 10, .14); --warn-fg: #ffcf8a;
          --panel-shadow: 0 16px 40px rgba(0, 0, 0, .36), 0 1px 3px rgba(0, 0, 0, .4); }
        .pill { display: flex; align-items: center; gap: 2px; padding: 4px 5px 4px 9px;
          border-radius: 999px; background: var(--pill-bg); color: var(--pill-fg);
          box-shadow: var(--pill-shadow), inset 0 0 0 1px var(--pill-ring);
          backdrop-filter: blur(8px); opacity: .82; transition: opacity .15s ease; user-select: none; }
        .pill:hover { opacity: 1; }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: #8b8f98; margin-right: 2px; flex: none; }
        .dot.ok { background: #34c759; box-shadow: 0 0 6px rgba(52, 199, 89, .7); }
        .dot.bad { background: #ff453a; }
        .name { font-weight: 600; letter-spacing: .2px; cursor: pointer; padding: 2px 4px; }
        .name:hover { color: var(--pill-name-hover); }
        .btn { border: 0; border-radius: 999px; padding: 4px 9px; margin-left: 2px; cursor: pointer;
          font: inherit; color: var(--btn-fg); background: var(--btn-bg); }
        .btn:hover { background: rgba(77, 107, 254, .35); color: #fff; }
        .btn.quit:hover { background: rgba(255, 69, 58, .32); }
        .panel { display: none; width: 264px; padding: 12px 13px; border-radius: 12px;
          background: var(--panel-bg); color: var(--panel-fg);
          box-shadow: var(--panel-shadow), inset 0 0 0 1px var(--pill-ring);
          backdrop-filter: blur(10px); }
        .panel.show { display: block; }
        .title { font-weight: 600; font-size: 12.5px; margin-bottom: 6px; display: flex; justify-content: space-between; }
        .muted { color: var(--muted-fg); }
        .row { display: flex; justify-content: space-between; gap: 10px; padding: 2px 0; }
        .row span:last-child { text-align: right; word-break: break-all; }
        .warn { margin-top: 8px; padding: 7px 8px; border-radius: 8px; background: var(--warn-bg);
          color: var(--warn-fg); font-size: 11px; line-height: 1.45; }
        .actions { display: flex; gap: 6px; margin-top: 10px; }
        .actions button { flex: 1; border: 0; border-radius: 8px; padding: 7px 8px; cursor: pointer;
          font: inherit; color: var(--panel-fg); background: var(--btn-bg); }
        .actions button:hover { background: rgba(77, 107, 254, .45); color: #fff; }
        .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; }
      </style>
      <div class="wrap">
        <div class="panel" part="panel">
          <div class="title"><span>远程入口 · dsh-webim</span><span class="muted mono" data-v></span></div>
          <div class="row"><span class="muted">本机 Harness</span><span class="mono" data-upstream>—</span></div>
          <div class="row"><span class="muted">已连接</span><span data-uptime>—</span></div>
          <div class="row"><span class="muted">本地文件</span><span data-files>—</span></div>
          <div class="actions">
            <button type="button" data-act="files">浏览本机文件</button>
            <button type="button" data-act="logout">退出登录</button>
          </div>
        </div>
        <div class="pill">
          <span class="dot" data-dot></span>
          <span class="name" data-act="toggle" title="dsh-webim 远程入口">远程</span>
          <button type="button" class="btn" data-act="files" title="浏览本机文件">文件</button>
          <button type="button" class="btn quit" data-act="logout" title="退出远程登录">退出</button>
        </div>
      </div>
    `

    if (document.documentElement.dataset.webimTheme) host.dataset.theme = document.documentElement.dataset.webimTheme
    const panel = root.querySelector('.panel')
    const dot = root.querySelector('[data-dot]')

    root.addEventListener('click', (event) => {
      const trigger = event.target.closest('[data-act]')
      if (!trigger) return
      const action = trigger.getAttribute('data-act')
      if (action === 'toggle') {
        panel.classList.toggle('show')
        if (panel.classList.contains('show')) void refreshStatus()
        return
      }
      if (action === 'files') {
        const win = window.open(`${BASE}/fs`, '_blank', 'noopener')
        if (!win) toast('浏览器拦截了新窗口')
        return
      }
      if (action === 'logout') {
        panel.classList.remove('show')
        fetch(`${BASE}/logout`, { method: 'POST', credentials: 'same-origin' }).finally(() => {
          location.replace(`${BASE}/login`)
        })
      }
    })

    async function refreshStatus() {
      try {
        const response = await fetch(`${BASE}/api/status`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const status = await response.json()
        state.status = status
        dot.classList.add('ok')
        dot.classList.remove('bad')
        root.querySelector('[data-v]').textContent = `v${status.version}`
        root.querySelector('[data-upstream]').textContent = String(status.upstream || '').replace(/^https?:\/\//u, '')
        root.querySelector('[data-uptime]').textContent = formatUptime(status.uptimeSeconds)
        root.querySelector('[data-files]').textContent = status.files?.enabled ? '可用' : '关闭'
      } catch (error) {
        dot.classList.add('bad')
        dot.classList.remove('ok')
        root.querySelector('[data-upstream]').textContent = '无法读取状态'
        root.querySelector('[data-files]').textContent = error instanceof Error ? error.message : String(error)
      }
    }

    /** Hide the file entry points when the file browser feature is off. */
    function applyFeatures(values) {
      const on = values?.fileBrowser !== false
      for (const node of root.querySelectorAll('[data-act="files"]')) {
        node.hidden = !on
        node.style.display = on ? '' : 'none'
      }
    }
    applyFeatures(state.features)
    window.__WEBIM_APPLY_FEATURES__ = applyFeatures

    const mount = () => {
      if (document.body) document.body.appendChild(host)
      else document.documentElement.appendChild(host)
      void refreshStatus()
    }
    if (document.body) mount()
    else document.addEventListener('DOMContentLoaded', mount, { once: true })
  }

  function formatUptime(seconds) {
    const value = Number(seconds) || 0
    if (value < 60) return `${value} 秒`
    if (value < 3600) return `${Math.floor(value / 60)} 分钟`
    if (value < 86400) return `${Math.floor(value / 3600)} 小时`
    return `${Math.floor(value / 86400)} 天`
  }

  function escapeText(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  }

  // ---------------------------------------------------------------------------
  // Mobile layout: drawer navigation, viewport and keyboard handling
  // ---------------------------------------------------------------------------

  const MOBILE_QUERY = '(max-width: 860px)'
  // `interactive-widget=resizes-content` makes the on-screen keyboard shrink the
  // layout viewport, so `100dvh` already ends above the keyboard and the composer
  // stays visible without any JavaScript measuring the visual viewport.
  const VIEWPORT_CONTENT = 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content'

  /** Make sure the shell really is a phone viewport (zoom stays allowed). */
  function ensureViewportMeta() {
    const head = document.head || document.documentElement
    let meta = head.querySelector('meta[name="viewport"]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.setAttribute('name', 'viewport')
      head.appendChild(meta)
    }
    const current = meta.getAttribute('content') || ''
    if (current === '' || /maximum-scale|user-scalable\s*=\s*no|initial-scale\s*=\s*0/iu.test(current)) {
      meta.setAttribute('content', VIEWPORT_CONTENT)
    } else if (!/viewport-fit/iu.test(current)) {
      meta.setAttribute('content', `${current.replace(/,\s*$/u, '')}, viewport-fit=cover`)
    } else if (!/interactive-widget/iu.test(current)) {
      meta.setAttribute('content', `${current.replace(/,\s*$/u, '')}, interactive-widget=resizes-content`)
    }
  }

  function sidebarColumn() {
    return document.querySelector('[class*="sidebarCol"], [class*="sidebar-col"], aside[role="navigation"]')
  }

  /** The app's own sidebar toggle: it expands the rail so real labels render. */
  function railToggle() {
    for (const button of document.querySelectorAll('button[aria-label]')) {
      const label = button.getAttribute('aria-label') || ''
      if (/侧边栏|sidebar|panel/iu.test(label) && !/右侧|right/iu.test(label)) return button
    }
    return null
  }

  /** Is the rail currently drawn narrow (icon-only)? */
  function railCollapsed() {
    const column = sidebarColumn()
    if (!column) return false
    return Boolean(column.querySelector('[class*="collapsed"], [class*="_collapsed"]'))
  }

  function createMobileUi() {
    if (state.mobile) return
    ensureViewportMeta()
    const media = window.matchMedia(MOBILE_QUERY)

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'webim-drawer-btn'
    button.setAttribute('aria-label', '会话列表')
    button.setAttribute('title', '会话列表')
    button.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>'

    const scrim = document.createElement('div')
    scrim.className = 'webim-scrim'
    scrim.addEventListener('click', closeDrawer)

    const api = {
      open: false,
      toggle() {
        if (api.open) closeDrawer()
        else openDrawer()
      },
      button,
    }
    state.mobile = api

    function openDrawer() {
      api.open = true
      // The rail renders icon-only while collapsed; ask the app itself to
      // expand, so the drawer shows real session titles instead of a bare rail.
      // That click lands inside the sidebar, so keep it from closing the drawer.
      if (railCollapsed()) {
        api.suppressClose = true
        railToggle()?.click()
        window.setTimeout(() => {
          api.suppressClose = false
        }, 300)
      }
      document.documentElement.classList.add('webim-drawer-open')
      button.setAttribute('aria-expanded', 'true')
    }

    function closeDrawer() {
      api.open = false
      document.documentElement.classList.remove('webim-drawer-open')
      button.setAttribute('aria-expanded', 'false')
    }

    // The app already turns its right panel into a full-width overlay on a
    // narrow screen, so this layer only owns the left drawer.

    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      api.toggle()
    })

    // Tapping anything inside the drawer closes it, so one tap = one navigation.
    document.addEventListener(
      'click',
      (event) => {
        if (!api.open) return
        if (api.suppressClose) return
        const column = sidebarColumn()
        if (!column) return
        const path = typeof event.composedPath === 'function' ? event.composedPath() : []
        if (!path.includes(column)) return
        if (event.target.closest('.webim-drawer-btn')) return
        window.setTimeout(closeDrawer, 120)
      },
      true,
    )

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      if (api.open) closeDrawer()
    })
    window.addEventListener('popstate', () => {
      closeDrawer()
    })

    // Swipe from the left edge opens the drawer; swipe left inside it closes.
    let startX = 0
    let startY = 0
    let tracking = false
    document.addEventListener(
      'touchstart',
      (event) => {
        if (!media.matches || event.touches.length !== 1) return
        const touch = event.touches[0]
        const fromEdge = touch.clientX <= 28
        if (api.open || fromEdge) {
          startX = touch.clientX
          startY = touch.clientY
          tracking = true
        }
      },
      { passive: true },
    )
    document.addEventListener(
      'touchend',
      (event) => {
        if (!tracking) return
        tracking = false
        const touch = event.changedTouches[0]
        if (!touch) return
        const dx = touch.clientX - startX
        const dy = Math.abs(touch.clientY - startY)
        if (dy > 60) return
        if (!api.open && dx > 56) openDrawer()
        else if (api.open && dx < -56) closeDrawer()
      },
      { passive: true },
    )

    // Height comes from `100dvh` in CSS. Measuring `visualViewport` here used to
    // resize the shell while the keyboard animated, which scrolled the focused
    // composer out from under the finger and dropped the keyboard again.
    const mount = () => {
      const body = document.body || document.documentElement
      body.appendChild(button)
      body.appendChild(scrim)
      applyMode()
    }

    const applyMode = () => {
      const on = media.matches
      document.documentElement.classList.toggle('webim-mobile', on)
      button.style.display = on ? '' : 'none'
      if (!on) closeDrawer()
    }

    if (typeof media.addEventListener === 'function') media.addEventListener('change', applyMode)
    else if (typeof media.addListener === 'function') media.addListener(applyMode)

    if (document.body) mount()
    else document.addEventListener('DOMContentLoaded', mount, { once: true })
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  const boot = (status) => {
    state.status = status
    state.features = status?.features ?? null
    if (state.features && state.features.mobileUi !== false) createMobileUi()
    if (!state.features || state.features.pill !== false) createPill()
    watchTheme()
    if (!state.features || state.features.linkifyPaths !== false) startLinkify()
  }

  fetch(`${BASE}/api/status`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
    .then((response) => (response.ok ? response.json() : null))
    .then((status) => boot(status))
    .catch(() => {
      // Status is best effort: keep the helpers usable when it cannot be read.
      setTimeout(() => boot(null), 1200)
    })
})()
