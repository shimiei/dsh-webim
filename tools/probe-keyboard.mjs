// Regression probe for the phone composer: opens a conversation, then shrinks
// the layout viewport to keyboard height (what `interactive-widget=resizes-content`
// does) and checks the composer is still inside the visible area afterwards.
// Usage: node tools/probe-keyboard.mjs <debug-port> <url> <shot.png>
import { writeFileSync } from 'node:fs'
import http from 'node:http'

const port = Number(process.argv[2] ?? 9246)
const url = process.argv[3]
const shot = process.argv[4] ?? 'artifacts/mobile-keyboard.png'
const WIDTH = 390
const FULL = 844
const KEYBOARD = 460

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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const s = (method, params) => send(method, params, sessionId)

const emulate = (height) =>
  s('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height,
    deviceScaleFactor: 2,
    mobile: true,
    screenWidth: WIDTH,
    screenHeight: height,
  })

await s('Page.enable')
await s('Runtime.enable')
await emulate(FULL)
await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await s('Emulation.setUserAgentOverride', {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  platform: 'iPhone',
})
await s('Page.navigate', { url })
await wait(12000)

// Accept the first-run notices.
for (let attempt = 0; attempt < 2; attempt += 1) {
  await s('Runtime.evaluate', {
    expression: `(() => {
      for (const label of document.querySelectorAll('label')) {
        if (label.textContent.includes('我已阅读')) { label.click(); break }
      }
      for (const text of ['我已知晓并继续', '继续']) {
        for (const el of document.querySelectorAll('button, [role="button"]')) {
          if ((el.textContent || '').trim() === text) { el.click(); break }
        }
      }
      return 'ok'
    })()`,
    returnByValue: true,
  })
  await wait(1800)
}

const measure = `(() => {
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { y: Math.round(r.y), h: Math.round(r.height), bottom: Math.round(r.bottom) }
  }
  return JSON.stringify({
    viewport: { w: window.innerWidth, h: window.innerHeight },
    seat: box(document.querySelector('[class*="composerSeat"], [class*="composer"]')),
    field: box(document.querySelector('textarea, [contenteditable="true"]')),
    frame: box(document.querySelector('[class*="_frame"]')),
    active: document.activeElement ? document.activeElement.tagName.toLowerCase() : null,
  })
})()`

const read = async () => {
  const result = await s('Runtime.evaluate', { expression: measure, returnByValue: true })
  return JSON.parse(result.result.value)
}

// Open a real conversation, which is what triggers the composer focus.
const opened = await s('Runtime.evaluate', {
  expression: `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    document.querySelector('.webim-drawer-btn')?.click()
    await wait(900)
    const rows = [...document.querySelectorAll('[class*="sessionRow"]')]
    const row = rows.find((el) => /远程接入插件设计/.test(el.textContent || '')) || rows[0]
    if (!row) return 'no-row'
    const label = (row.textContent || '').trim().slice(0, 22)
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    row.click()
    await wait(2500)
    return 'clicked:' + label + ' msgs=' + document.querySelectorAll('[class*="message"]').length
  })()`,
  returnByValue: true,
  awaitPromise: true,
})
console.log('OPEN:', opened.result.value)

const before = await read()
console.log('BEFORE:', JSON.stringify(before))

await emulate(KEYBOARD)
await wait(1200)
const typing = await read()
console.log('KEYBOARD:', JSON.stringify(typing))

await emulate(FULL)
await wait(1200)
const after = await read()
console.log('AFTER:', JSON.stringify(after))

const shotResult = await s('Page.captureScreenshot', { format: 'png' })
writeFileSync(shot, Buffer.from(shotResult.data, 'base64'))
console.log('SHOT:', shot)

const problems = []
if (!before.seat) problems.push('composer missing before keyboard')
if (!typing.seat) problems.push('composer missing while keyboard is up')
if (typing.seat && typing.seat.bottom > typing.viewport.h + 1) problems.push('composer below the visible area')
if (after.seat && after.seat.bottom > after.viewport.h + 1) problems.push('composer below the viewport after keyboard closed')
if (after.seat && after.seat.y > after.viewport.h) problems.push('composer pushed out of view after keyboard closed')
console.log('PROBLEMS:', problems.length ? problems.join('; ') : 'none')
await send('Target.closeTarget', { targetId }).catch(() => {})
ws.close()
