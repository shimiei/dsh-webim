// Inspect the DSH web UI layout through a mobile emulation profile (no npm deps).
// Usage: node tools/inspect-mobile.mjs <debug-port> <url> <out.json> [--dismiss] [--drawer|--aside] [--eval-file <path>]
import { readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'

const port = Number(process.argv[2] ?? 9231)
const url = process.argv[3]
const out = process.argv[4] ?? 'artifacts/mobile-dom.json'
const dismiss = process.argv.includes('--dismiss')
const openDrawer = process.argv.includes('--drawer')
const openAside = process.argv.includes('--aside')
const evalFileIndex = process.argv.indexOf('--eval-file')
const evalScript = evalFileIndex === -1 ? '' : readFileSync(process.argv[evalFileIndex + 1] ?? '', 'utf8')

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
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  }
})

function send(method, params = {}, sessionId) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const s = (method, params) => send(method, params, sessionId)

await s('Page.enable')
await s('Runtime.enable')
await s('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
  screenWidth: 390,
  screenHeight: 844,
})
await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await s('Emulation.setUserAgentOverride', {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  platform: 'iPhone',
})
await s('Page.navigate', { url })
await new Promise((resolve) => setTimeout(resolve, 12000))

if (dismiss) {
  const script = `(() => {
    for (const label of document.querySelectorAll('label')) {
      if (label.textContent.includes('我已阅读')) { label.click(); break }
    }
    for (const text of ['我已知晓并继续', '继续']) {
      for (const el of document.querySelectorAll('button, [role="button"]')) {
        if ((el.textContent || '').trim() === text) { el.click(); break }
      }
    }
    return 'ok'
  })()`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await s('Runtime.evaluate', { expression: script, returnByValue: true })
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

if (evalScript) {
  const result = await s('Runtime.evaluate', { expression: evalScript, returnByValue: true, awaitPromise: true })
  console.log('EVAL:', JSON.stringify(result.result?.value ?? result.result?.description ?? null))
  await new Promise((resolve) => setTimeout(resolve, 400))
}

if (openAside) {
  const opened = await s('Runtime.evaluate', {
    expression: `(() => {
      const trigger = [...document.querySelectorAll('button[aria-label]')].find((el) =>
        /右侧边栏|right sidebar/iu.test(el.getAttribute('aria-label') || ''),
      )
      if (!trigger) return 'missing'
      trigger.click()
      return 'clicked'
    })()`,
    returnByValue: true,
  })
  console.log('ASIDE:', opened.result.value)
  await new Promise((resolve) => setTimeout(resolve, 700))
}

if (openDrawer) {
  const opened = await s('Runtime.evaluate', {
    expression: `(() => {
      const button = document.querySelector('.webim-drawer-btn')
      if (!button) return 'missing'
      button.click()
      return 'clicked'
    })()`,
    returnByValue: true,
  })
  console.log('DRAWER:', opened.result.value)
  await new Promise((resolve) => setTimeout(resolve, 600))
}

const dump = `(() => {
  const describe = (el, depth) => {
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return {
      d: depth,
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      cls: (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 90),
      role: el.getAttribute('role') || '',
      label: el.getAttribute('aria-label') || '',
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.width), h: Math.round(rect.height),
      pos: style.position,
      disp: style.display,
      vis: style.visibility,
      ovf: style.overflowX + '/' + style.overflowY,
      z: style.zIndex,
      fixedLike: ['fixed', 'sticky', 'absolute'].includes(style.position),
      text: (el.children.length === 0 ? (el.textContent || '').trim().slice(0, 40) : ''),
      scrollW: el.scrollWidth, clientW: el.clientWidth,
    }
  }
  const rows = []
  const walk = (el, depth) => {
    if (depth > 7 || rows.length > 260) return
    rows.push(describe(el, depth))
    for (const child of el.children) walk(child, depth + 1)
  }
  if (document.body) walk(document.body, 0)
  return JSON.stringify({
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    docScrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body?.scrollWidth ?? -1,
    rows,
  })
})()`

const result = await s('Runtime.evaluate', { expression: dump, returnByValue: true })
writeFileSync(out, result.result.value ?? '{}')
console.log('WROTE:', out, 'bytes=', (result.result.value ?? '').length)
const shot = await s('Page.captureScreenshot', { format: 'png' })
const shotPath = out.replace(/\.json$/u, '.png')
writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
console.log('SHOT:', shotPath)
// Every run creates a page target; leaving them open piles up full app instances
// until the browser stops answering. Always close the page we opened.
await send('Target.closeTarget', { targetId }).catch(() => {})
ws.close()
