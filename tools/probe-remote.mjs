// Headless-Edge diagnosis for the remote dsh-webim entry (no npm deps).
// Usage: node tools/probe-remote.mjs <debug-port> <url> <screenshot.png>
import { readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'

const port = Number(process.argv[2] ?? 9223)
const url = process.argv[3]
const shot = process.argv[4] ?? 'artifacts/probe.png'
const dismiss = process.argv.includes('--dismiss')
const mediaIndex = process.argv.indexOf('--media')
const media = mediaIndex === -1 ? null : (process.argv[mediaIndex + 1] ?? null)
const evalIndex = process.argv.indexOf('--eval')
const evalFileIndex = process.argv.indexOf('--eval-file')
const evalScript = evalFileIndex !== -1
  ? readFileSync(process.argv[evalFileIndex + 1] ?? '', 'utf8')
  : evalIndex === -1 ? '' : (process.argv[evalIndex + 1] ?? '')

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
const events = []
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
    return
  }
  events.push(message)
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

await s('Runtime.enable')
await s('Log.enable')
await s('Network.enable')
await s('Page.enable')
const sizeIndex = process.argv.indexOf('--size')
const size = sizeIndex === -1 ? null : (process.argv[sizeIndex + 1] ?? null)
const dprIndex = process.argv.indexOf('--dpr')
const dpr = dprIndex === -1 ? 1 : Number(process.argv[dprIndex + 1] ?? 1)
if (size) {
  const [width, height] = size.split('x').map(Number)
  await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: true })
  await s('Emulation.setTouchEmulationEnabled', { enabled: true })
}
if (media) {
  await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: media }] })
}
await s('Page.navigate', { url })

await new Promise((resolve) => setTimeout(resolve, 12000))

// Optional: accept the first-run notices so the screenshot shows the real UI.
const dismissScript = `(() => {
  const clicked = []
  for (const label of document.querySelectorAll('label')) {
    if (label.textContent.includes('我已阅读')) { label.click(); clicked.push('consent'); break }
  }
  for (const text of ['我已知晓并继续', '继续']) {
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      if ((el.textContent || '').trim() === text) { el.click(); clicked.push(text); break }
    }
  }
  return clicked.join(',') || 'none'
})()`

if (dismiss) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await s('Runtime.evaluate', { expression: dismissScript, returnByValue: true })
    if (result.result.value !== 'none') break
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  await new Promise((resolve) => setTimeout(resolve, 2500))
}

if (evalScript !== '') {
  const extra = await s('Runtime.evaluate', { expression: evalScript, returnByValue: true, awaitPromise: true })
  console.log('EVAL:', JSON.stringify(extra.result?.value ?? extra.result?.description ?? null))
  await new Promise((resolve) => setTimeout(resolve, 1500))
}

const info = await s('Runtime.evaluate', {
  expression: `JSON.stringify({
    title: document.title,
    href: location.href,
    ready: document.readyState,
    bodyText: (document.body?.innerText ?? '').slice(0, 1200),
    bodyHtmlHead: (document.body?.innerHTML ?? '').slice(0, 600),
    rootHtmlLength: document.getElementById('root')?.innerHTML?.length ?? -1,
    bootKeys: window.__DSH_BOOT__ ? Object.keys(window.__DSH_BOOT__) : null,
    loader: typeof window.__ModuleLoader__,
    webim: Boolean(window.__WEBIM__),
  })`,
  returnByValue: true,
})

const consoleLines = []
const failed = []
const badStatus = []
for (const event of events) {
  if (event.method === 'Runtime.consoleAPICalled') {
    const args = (event.params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(' ')
    consoleLines.push(`${event.params.type}: ${args}`)
  } else if (event.method === 'Runtime.exceptionThrown') {
    const d = event.params.exceptionDetails
    consoleLines.push(`EXCEPTION ${d.text} ${d.exception?.description?.split('\n').slice(0, 3).join(' | ') ?? ''}`)
  } else if (event.method === 'Log.entryAdded') {
    consoleLines.push(`LOG ${event.params.entry.level}: ${event.params.entry.text}`)
  } else if (event.method === 'Network.loadingFailed') {
    failed.push(`${event.params.errorText} ${event.params.type}`)
  } else if (event.method === 'Network.responseReceived') {
    const r = event.params.response
    if (r.status >= 400) badStatus.push(`${r.status} ${r.url}`)
  }
}

const screenshot = await s('Page.captureScreenshot', { format: 'png' })
writeFileSync(shot, Buffer.from(screenshot.data, 'base64'))

console.log('PAGE:', info.result.value)
console.log('SHOT:', shot)
console.log('CONSOLE (' + consoleLines.length + '):')
for (const line of consoleLines.slice(0, 40)) console.log('  ' + line)
console.log('FAILED REQUESTS (' + failed.length + '):')
for (const line of failed.slice(0, 20)) console.log('  ' + line)
console.log('BAD STATUS (' + badStatus.length + '):')
for (const line of badStatus.slice(0, 20)) console.log('  ' + line)
ws.close()
