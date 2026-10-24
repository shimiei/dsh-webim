// Drives the plugin the way the panel does (public mode → tunnel mode) with a
// recording logger, so a silent tunnel-start failure becomes visible.
import http from 'node:http'
import net from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const lines = []

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

const upstream = http.createServer((req, res) => {
  if (req.url.startsWith('/__auth')) {
    res.writeHead(200, { 'set-cookie': 'harness-session=minted; Path=/; HttpOnly' })
    res.end('ok')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html><body>probe</body></html>')
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamPort = upstream.address().port

const stateDir = await mkdtemp(join(tmpdir(), 'webim-mode-probe-'))
const port = await freePort()
const rpcCalls = []

const ctx = {
  logger: { info: (message) => lines.push(message), debug: () => {}, warn: () => {} },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  get(name) {
    if (name === 'webServer') {
      return {
        register: () => () => {},
        getOrigin: () => `http://127.0.0.1:${upstreamPort}`,
      }
    }
    if (name === 'connection') return this.connection
    return undefined
  },
  connection: {
    rpc: {
      handle(channel, handler) { rpcCalls.push({ channel, handler }); return () => {} },
    },
  },
}

const dispose = apply(ctx, {
  host: '127.0.0.1',
  port,
  stateDir,
  password: '124',
  publicUrl: 'https://dsh.example.com',
})
const rpc = (endpoint, payload) => rpcCalls.find((c) => c.channel === '/webim').handler(endpoint, payload || {})

try {
  await sleep(600)
  console.log('1) public mode:', JSON.stringify((await rpc('setFeatures', { features: { lan: true, public: true, tunnel: false } })).value.reach))
  await sleep(1500)
  const tunnelMode = await rpc('setFeatures', { features: { lan: true, public: false, tunnel: true } })
  console.log('2) tunnel mode reach:', JSON.stringify(tunnelMode.value.reach), 'tunnel:', JSON.stringify(tunnelMode.value.tunnel))
  for (let i = 0; i < 24; i += 1) {
    await sleep(1000)
    const info = (await rpc('info', {})).value
    const t = info.tunnel
    if (i % 3 === 0 || t.url || t.error) {
      console.log(`   +${i + 1}s starting=${t.starting} running=${t.running} url=${t.url || '-'} error=${t.error || '-'} entries=${info.access.urls.map((u) => u.kind).join(',')}`)
    }
    if (t.url || t.error) break
  }
} finally {
  await dispose()
  upstream.close()
  await rm(stateDir, { recursive: true, force: true })
  console.log('--- plugin log ---')
  for (const line of lines) console.log(line)
  process.exit(0)
}
