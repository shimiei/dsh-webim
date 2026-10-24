// Deeper headless-Edge diagnosis: capture inline-script contents and the exact
// SyntaxError positions for the remote entry page (no npm deps).
// Usage: node tools/probe-page.mjs <debug-port> <url>
import { writeFileSync } from 'node:fs'
import http from 'node:http'

const port = Number(process.argv[2] ?? 9223)
const url = process.argv[3]

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
    const entry = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
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
await s('Page.navigate', { url })
await new Promise((resolve) => setTimeout(resolve, 8000))

const scripts = await s('Runtime.evaluate', {
  expression: `(() => {
    const out = []
    for (const el of document.querySelectorAll('script:not([src])')) {
      const text = el.textContent ?? ''
      let error = ''
      try { new Function(text) } catch (e) { error = String(e) }
      out.push({ length: text.length, error, head: text.slice(0, 120), tail: text.slice(-120) })
    }
    return JSON.stringify(out)
  })()`,
  returnByValue: true,
})

const doc = await s('Runtime.evaluate', {
  expression: `JSON.stringify({ contentType: document.contentType, charset: document.characterSet })`,
  returnByValue: true,
})

console.log('DOC:', doc.result.value)
console.log('INLINE SCRIPTS:')
for (const entry of JSON.parse(scripts.result.value)) {
  console.log('  len=' + entry.length + ' error=' + (entry.error || 'none'))
  console.log('    head=' + JSON.stringify(entry.head))
  console.log('    tail=' + JSON.stringify(entry.tail))
}

const exceptions = []
for (const event of events) {
  if (event.method === 'Runtime.exceptionThrown') {
    const d = event.params.exceptionDetails
    exceptions.push({
      text: d.text,
      url: d.url,
      line: d.lineNumber,
      column: d.columnNumber,
      scriptId: d.scriptId,
      description: (d.exception?.description ?? '').slice(0, 300),
    })
  }
}
console.log('EXCEPTIONS:')
for (const e of exceptions) console.log('  ' + JSON.stringify(e))

const responseHeaders = []
for (const event of events) {
  if (event.method === 'Network.responseReceived' && event.params.type === 'Document') {
    responseHeaders.push(event.params.response.headers)
  }
}
console.log('DOCUMENT RESPONSE HEADERS:')
for (const headers of responseHeaders) console.log('  ' + JSON.stringify(headers))

ws.close()
