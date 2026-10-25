// Produce the README screenshots from the running panel, with every private
// detail replaced: LAN/public addresses, tunnel hostname, token and the QR all
// become documentation placeholders (RFC 5737 / example.com).
//
// Usage (headless Edge must already listen on <debug-port>):
//   node tools/make-shots.mjs <debug-port> <entry-url-with-token> [outDir]
//
// The entry URL is only used to open the panel and is never written to disk.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
import { renderSvg } from '../lib/qr.js'

const port = Number(process.argv[2] ?? 9254)
const url = process.argv[3]
const outDir = process.argv[4] ?? 'docs/shots'
if (!url) {
  console.error('usage: node tools/make-shots.mjs <debug-port> <entry-url-with-token> [outDir]')
  process.exit(2)
}

// A deliberately fake, obviously-not-real entry used in the docs.
const DEMO_URL = 'https://dsh-demo.example.com/?token=DEMO-TOKEN-000000000000000000000000000'
const DEMO_TUNNEL = 'https://lantern-4821.trycloudflare.com'
const DEMO_LAN = '192.0.2.45'
const DEMO_PUBLIC = '203.0.113.7'
const DEMO_TOKEN = 'DEMO-TOKEN-000000000000000000000000000'

function httpJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch (error) { reject(error) } })
    }).on('error', reject)
  })
}

const version = await httpJson('/json/version')
const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result)
  }
})

function send(method, params = {}, sessionId) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`timeout: ${method}`))
      }
    }, 45000)
  })
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const call = (method, params) => send(method, params, sessionId)

await call('Page.enable')
await call('Runtime.enable')
// DSH follows the OS theme, and a headless browser reports "light". Pin the
// captures so the palette is deterministic: `--theme light` audits the light UI.
const theme = process.argv.includes('--theme')
  ? (process.argv[process.argv.indexOf('--theme') + 1] ?? 'dark')
  : 'dark'
await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
await call('Emulation.setDeviceMetricsOverride', {
  width: 1360, height: 940, deviceScaleFactor: 2, mobile: false,
})

async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'evaluate failed')
  return result.result?.value
}

/** Open 设置 → 远程接入 on whatever page is loaded. */
const OPEN_PANEL = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  // A first-run notice can sit on top of everything; accept it before looking
  // for the panel, otherwise the screenshot is half modal.
  for (let i = 0; i < 6; i += 1) {
    const ack = [...document.querySelectorAll('button, [role="button"]')]
      .find((el) => /我已知晓|知道了|继续/u.test((el.textContent || '').trim()))
    if (!ack) break
    ack.click()
    await wait(600)
  }
  for (let i = 0; i < 40 && !document.querySelector('.wb'); i += 1) {
    ;[...document.querySelectorAll('button, [role="button"]')]
      .find((el) => el.getAttribute('aria-label') === '账号菜单')?.click()
    await wait(500)
    ;[...document.querySelectorAll('[role="menuitem"], [class*="_item_"]')]
      .find((el) => /^设置/u.test((el.textContent || '').trim()))?.click()
    await wait(1200)
    ;[...document.querySelectorAll('[role="dialog"] nav button, dialog[open] nav button')]
      .find((el) => /远程接入/u.test(el.textContent || ''))?.click()
    await wait(1200)
  }
  return Boolean(document.querySelector('.wb'))
})()`

/**
 * Replace hostnames, addresses and the token, then swap the QR for a code that
 * points at the demo entry. One pass with a decider function, because chained
 * replacements would rewrite the placeholders themselves.
 */
const sanitize = (qrSvg) => `(() => {
  const qr = ` + JSON.stringify(qrSvg) + `
  const DEMO = {
    tunnel: ${JSON.stringify(DEMO_TUNNEL)},
    lan: ${JSON.stringify(DEMO_LAN)},
    public: ${JSON.stringify(DEMO_PUBLIC)},
    token: ${JSON.stringify(DEMO_TOKEN)},
  }
  const KEEP = /^(?:0\\.0\\.0\\.0|127\\.0\\.0\\.1|255\\.|192\\.0\\.2\\.)/
  const fix = (text) => text
    .replace(/https:\\/\\/[a-z0-9-]+\\.trycloudflare\\.com/gi, DEMO.tunnel)
    .replace(/\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b/g, (ip) => {
      if (KEEP.test(ip)) return ip
      if (/^192\\.168\\./.test(ip) || /^10\\./.test(ip) || /^172\\.(1[6-9]|2\\d|3[01])\\./.test(ip)) return DEMO.lan
      return DEMO.public
    })
    .replace(/token=[^&\\s"']+/g, 'token=' + DEMO.token)
    .replace(/(?<!token=)\\b[A-Za-z0-9_-]{40,}\\b/g, DEMO.token)
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) nodes.push(walker.currentNode)
  for (const node of nodes) {
    const value = node.nodeValue || ''
    if (!/[0-9A-Za-z]/.test(value)) continue
    const next = fix(value)
    if (next !== value) node.nodeValue = next
  }
  for (const el of document.querySelectorAll('[placeholder], [value], [title], [href]')) {
    for (const attr of ['placeholder', 'value', 'title', 'href']) {
      const raw = el.getAttribute(attr)
      if (!raw) continue
      const next = fix(raw)
      if (next !== raw) el.setAttribute(attr, next)
    }
  }
  // Inputs keep their text in the value *property*; the attribute alone would
  // leave the real address on screen because React re-renders from state.
  for (const el of document.querySelectorAll('input, textarea')) {
    if (typeof el.value === 'string' && el.value) el.value = fix(el.value)
  }
  const box = document.querySelector('.wb-qrcode')
  if (box) {
    box.innerHTML = qr
    box.style.background = '#ffffff'
    box.style.color = '#0b0b0d'
  }
  // Drop anything that dims or covers the panel: the host can put a consent
  // notice (and its backdrop) on top, which would wash out the screenshot.
  const panel = document.querySelector('.wb')
  const covers = (el) => {
    const r = el.getBoundingClientRect()
    return r.width > innerWidth * 0.8 && r.height > innerHeight * 0.8
  }
  for (const el of [...document.body.querySelectorAll('*')]) {
    if (panel.contains(el) || el.contains(panel)) continue
    const style = getComputedStyle(el)
    if (style.position !== 'fixed' && style.position !== 'absolute') continue
    if (!covers(el)) continue
    const parts = /rgba?\(([^)]+)\)/.exec(style.backgroundColor)
    const alpha = parts && parts[1].split(',').length === 4 ? parseFloat(parts[1].split(',')[3]) : 1
    const blurred = style.backdropFilter && style.backdropFilter !== 'none'
    if (alpha < 1 || blurred) el.remove()
  }
  for (const el of [...document.querySelectorAll('[role="dialog"], dialog')]) {
    if (el.contains(panel) || panel.contains(el)) continue
    el.remove()
  }
  return document.querySelector('.wb')?.textContent?.length ?? 0
})()`

async function capture(name, expression = '') {
  if (expression) await evaluate(expression)
  await wait(400)
  // Any first-run notice on top dims the whole panel through its backdrop, so
  // clear it before shooting. Retry a few times: the notice can mount late.
  for (let i = 0; i < 8; i += 1) {
    const dismissed = await evaluate(`(() => {
      const ack = [...document.querySelectorAll('button, [role="button"]')]
        .filter((el) => !el.closest('.wb'))
        .find((el) => /我已知晓|知道了|同意|继续/u.test((el.textContent || '').trim()))
      if (!ack) return false
      ack.click()
      return true
    })()`)
    if (!dismissed) break
    await wait(600)
  }
  // Clip to the panel's real content, not its declared box: the settings dialog
  // can be taller than the panel and would leave dead space in the screenshot.
  const box = await evaluate(`(() => {
    const el = document.querySelector('.wb')
    if (!el) return null
    const rect = el.getBoundingClientRect()
    let bottom = rect.top
    for (const child of el.children) {
      const r = child.getBoundingClientRect()
      if (r.height > 0) bottom = Math.max(bottom, r.bottom)
    }
    // The panel can be taller than the dialog that scrolls it: clamp so the
    // shot never runs past the dialog's rounded edge into the page background.
    const dialog = el.closest('[role="dialog"], dialog, [class*="dialog"]')
    if (dialog) {
      const dr = dialog.getBoundingClientRect()
      if (dr.height > 40) bottom = Math.min(bottom, dr.bottom - 12)
    }
    return { x: rect.x, y: rect.y, width: rect.width, height: Math.max(120, bottom - rect.top) }
  })()`)
  if (!box) throw new Error('panel not found')
  const padX = 16
  const padY = 6
  const shot = await call('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: {
      x: Math.max(0, box.x - padX),
      y: Math.max(0, box.y - padY),
      width: box.width + padX * 2,
      height: box.height + padY * 2,
      scale: 2,
    },
  })
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, name)
  writeFileSync(file, Buffer.from(shot.data, 'base64'))
  console.log(`${name}: ${Math.round(box.width)}x${Math.round(box.height)}`)
}

const qrSvg = renderSvg(DEMO_URL, { margin: 2 })

try {
  // ---- desktop, tunnel mode (the shape the docs lead with) ----
  await call('Page.navigate', { url })
  await wait(6000)
  if (!(await evaluate(OPEN_PANEL))) throw new Error('settings panel did not mount')
  await wait(1500)
  await capture('settings-tunnel.png', sanitize(qrSvg))

  // ---- desktop, public address (shows the field + two entries) ----
  await evaluate(`(() => {
    const el = document.querySelector('.wb')
    ;[...el.querySelectorAll('.wb-seg-item')].find((b) => /公网直连/u.test(b.textContent || ''))?.click()
    return true
  })()`)
  await wait(5000)
  await capture('settings-public.png', sanitize(qrSvg))

  // ---- mobile, back on the tunnel shape, which is the phone story ----
  await evaluate(`(() => {
    const el = document.querySelector('.wb')
    ;[...el.querySelectorAll('.wb-seg-item')].find((b) => /^Cloudflare/u.test(b.textContent || ''))?.click()
    return true
  })()`)
  await wait(9000)
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 1700, deviceScaleFactor: 2, mobile: true,
  })
  await wait(1600)
  await capture('settings-mobile.png', sanitize(qrSvg))

  // ---- back to the tunnel shape the owner actually runs ----
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1360, height: 940, deviceScaleFactor: 2, mobile: false,
  })
  await evaluate(`(() => {
    const el = document.querySelector('.wb')
    ;[...el.querySelectorAll('.wb-seg-item')].find((b) => /^Cloudflare/u.test(b.textContent || ''))?.click()
    return true
  })()`)
  await wait(9000)
  await evaluate(sanitize(qrSvg))
} finally {
  await send('Target.closeTarget', { targetId }).catch(() => {})
  ws.close()
}
