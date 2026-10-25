import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGateway } from '../lib/gateway.js'

function createUpstream() {
  const state = { requests: [], upgrades: [] }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      if (req.url === '/') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': ['upstream-only=1; Path=/; HttpOnly'],
        })
        res.end('<!doctype html><html><head><title>Harness</title></head><body>hello-harness</body></html>')
        return
      }
      if (req.url.startsWith('/api/echo')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ host: req.headers.host, cookie: req.headers.cookie, origin: req.headers.origin, body }))
        return
      }
      if (req.url === '/api/redirect') {
        res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/next` })
        res.end()
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    })
  })
  server.on('upgrade', (req, socket) => {
    state.upgrades.push({ headers: req.headers })
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fake-accept\r\n\r\n',
    )
    socket.on('data', (chunk) => socket.write(chunk))
    // A real WebSocket endpoint closes when its peer goes away; the bare TCP
    // socket used here stays half-open without this.
    socket.on('end', () => socket.destroy())
  })
  return { server, state }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address())))
}

// Sessions are pinned to a User-Agent, so every request in these tests has to
// carry the same one — including the raw WebSocket upgrade, which bypasses fetch.
const TEST_UA = 'dsh-webim-test/1.0'

function rawUpgrade(port, cookie) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [
        'GET /api/remote.mux HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        `User-Agent: ${TEST_UA}`,
      ]
      if (cookie) lines.push(`Cookie: ${cookie}`)
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => reject(new Error('upgrade timeout')), 4000)
    timer.unref()
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const index = buffer.indexOf('\r\n\r\n')
      if (index === -1) return
      clearTimeout(timer)
      socket.off('data', onData)
      resolve({ socket, head: buffer.subarray(0, index).toString('latin1'), rest: buffer.subarray(index + 4) })
    }
    socket.on('data', onData)
    socket.on('error', reject)
  })
}

function waitForData(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('data timeout')), 4000)
    timer.unref()
    const onData = (chunk) => {
      if (!predicate(chunk)) return
      clearTimeout(timer)
      socket.off('data', onData)
      resolve(chunk)
    }
    socket.on('data', onData)
  })
}

async function login(port, password, next = '/') {
  const response = await fetch(`http://127.0.0.1:${port}/__webim/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': TEST_UA },
    body: new URLSearchParams({ password, next }).toString(),
  })
  const setCookies = response.headers.getSetCookie?.() ?? []
  return { response, setCookie: setCookies[0]?.split(';')[0] ?? '', location: response.headers.get('location') }
}

describe('dsh-webim gateway', () => {
  let upstream
  let upstreamInfo
  let gateway
  let port
  let stateDir
  let fsRoot
  let cookie

  before(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'webim-state-'))
    fsRoot = await mkdtemp(join(tmpdir(), 'webim-fs-'))
    await writeFile(join(fsRoot, 'hello.txt'), 'hello world payload', 'utf8')
    await mkdir(join(fsRoot, 'sub'))
    await writeFile(join(fsRoot, 'sub', 'nested.json'), '{"ok":true}', 'utf8')
    upstream = createUpstream()
    upstreamInfo = await listen(upstream.server)
    gateway = createGateway({
      config: {
        host: '127.0.0.1',
        port: 0,
        password: '124',
        stateDir,
        sessionDays: 30,
        maxFailures: 100,
        blockMinutes: 15,
        allowedRoots: [fsRoot],
      },
      upstreamOrigin: `http://127.0.0.1:${upstreamInfo.port}`,
      getCookie: async () => 'UPSTREAM_SESSION=abc',
      invalidateCookie: () => {},
      log: () => {},
    })
    const address = await gateway.listen()
    port = address.port
    const result = await login(port, '124')
    assert.equal(result.response.status, 303)
    cookie = result.setCookie
    assert.ok(cookie.startsWith('dsh_webim='))
  })

  after(async () => {
    await gateway?.close()
    await new Promise((resolve) => {
      upstream.server.close(resolve)
      upstream.server.closeAllConnections?.()
    })
    await rm(stateDir, { recursive: true, force: true })
    await rm(fsRoot, { recursive: true, force: true })
  })

  it('does not proxy unauthenticated document requests', async () => {
    const before = upstream.state.requests.length
    const response = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' })
    assert.equal(response.status, 401)
    const html = await response.text()
    assert.match(html, /action="\/__webim\/login"/u)
    assert.equal(upstream.state.requests.length, before)
  })

  it('rejects wrong passwords without setting a cookie', async () => {
    const result = await login(port, '125')
    assert.equal(result.response.status, 401)
    assert.equal(result.setCookie, '')
  })

  it('sets a signed cookie on the right password and rejects cross-site redirect targets', async () => {
    const result = await login(port, '124', '//evil.example/steal')
    assert.equal(result.response.status, 303)
    assert.equal(result.location, '/')
  })

  it('serves the real Harness HTML with only the webim add-on injected', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie, 'user-agent': TEST_UA }, redirect: 'manual' })
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /hello-harness/u)
    assert.match(html, /\/__webim\/client\.js\?v=/u)
    assert.match(html, /\/__webim\/client\.css\?v=/u)
    assert.equal(response.headers.getSetCookie().length, 0)
    const last = upstream.state.requests.at(-1)
    assert.equal(last.headers.cookie, 'UPSTREAM_SESSION=abc')
    assert.equal(last.headers.host, `127.0.0.1:${upstreamInfo.port}`)
  })

  it('proxies API requests with the upstream origin and body', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/echo?q=1`, {
      method: 'POST',
      headers: { cookie, 'user-agent': TEST_UA, 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      body: '{"hello":"remote"}',
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.host, `127.0.0.1:${upstreamInfo.port}`)
    assert.equal(payload.origin, `http://127.0.0.1:${upstreamInfo.port}`)
    assert.equal(payload.cookie, 'UPSTREAM_SESSION=abc')
    assert.equal(payload.body, '{"hello":"remote"}')
    // The browser's gateway cookie must never leak upstream.
    assert.ok(!payload.cookie.includes('dsh_webim'))
  })

  it('rewrites absolute upstream redirects to gateway-relative paths', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/redirect`, { headers: { cookie, 'user-agent': TEST_UA }, redirect: 'manual' })
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), '/next')
  })

  it('returns 401 JSON for unauthenticated API calls', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, { redirect: 'manual' })
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { ok: false, error: 'login required' })
  })

  it('bridges WebSocket upgrades only with a valid session', async () => {
    const unauthorized = await rawUpgrade(port, '')
    assert.match(unauthorized.head, /^HTTP\/1\.1 401/u)
    unauthorized.socket.destroy()

    const authorized = await rawUpgrade(port, cookie)
    assert.match(authorized.head, /^HTTP\/1\.1 101/u)
    assert.equal(upstream.state.upgrades.at(-1).headers.cookie, 'UPSTREAM_SESSION=abc')
    authorized.socket.write('ping-bytes')
    const echoed = await waitForData(authorized.socket, (chunk) => chunk.toString().includes('ping-bytes'))
    assert.match(echoed.toString(), /ping-bytes/u)
    authorized.socket.destroy()
  })

it('rejects a valid cookie replayed from a different browser', async () => {
    const same = await fetch(`http://127.0.0.1:${port}/__webim/api/status`, {
      headers: { cookie, 'user-agent': TEST_UA },
    })
    assert.equal(same.status, 200)

    const other = await fetch(`http://127.0.0.1:${port}/__webim/api/status`, {
      headers: { cookie, 'user-agent': 'Mozilla/5.0 (some other device)' },
    })
    assert.equal(other.status, 401)

    const anonymous = await fetch(`http://127.0.0.1:${port}/__webim/api/status`, { headers: { cookie } })
    assert.equal(anonymous.status, 401)
  })

  it('lists directories and streams files through /__webim/fs', async () => {
    const list = await fetch(`http://127.0.0.1:${port}/__webim/fs?path=${encodeURIComponent(fsRoot)}&format=json`, {
      headers: { cookie, 'user-agent': TEST_UA },
    })
    assert.equal(list.status, 200)
    const payload = await list.json()
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.entries.map((entry) => entry.name), ['sub', 'hello.txt'])

    const file = await fetch(`http://127.0.0.1:${port}/__webim/fs?path=${encodeURIComponent(join(fsRoot, 'hello.txt'))}`, {
      headers: { cookie, 'user-agent': TEST_UA },
    })
    assert.equal(file.status, 200)
    assert.equal(file.headers.get('content-type'), 'text/plain; charset=utf-8')
    assert.equal(await file.text(), 'hello world payload')

    const range = await fetch(`http://127.0.0.1:${port}/__webim/fs?path=${encodeURIComponent(join(fsRoot, 'hello.txt'))}`, {
      headers: { cookie, 'user-agent': TEST_UA, range: 'bytes=0-4' },
    })
    assert.equal(range.status, 206)
    assert.equal(await range.text(), 'hello')
  })

  it('renders the file browser in the theme the shell asked for', async () => {
    const url = (extra) => `http://127.0.0.1:${port}/__webim/fs?path=${encodeURIComponent(fsRoot)}${extra}`
    const get = (extra) => fetch(url(extra), { headers: { cookie, 'user-agent': TEST_UA } })

    const lightHtml = await (await get('&theme=light')).text()
    assert.match(lightHtml, /<html lang="zh-CN" data-theme="light">/u)
    assert.match(lightHtml, /--fb-bg:#f6f7f9/u)
    // Navigation keeps the theme for every link on the page.
    assert.match(lightHtml, /&amp;theme=light|&theme=light/u)

    const darkHtml = await (await get('&theme=dark')).text()
    assert.match(darkHtml, /<html lang="zh-CN" data-theme="dark">/u)
    assert.match(darkHtml, /--fb-bg:#151517/u)

    // No parameter: the page is left to the operating system.
    const plainHtml = await (await get('')).text()
    assert.match(plainHtml, /<html lang="zh-CN"><head>/u)
    assert.match(plainHtml, /prefers-color-scheme:dark/u)
  })

  it('refuses relative paths, out-of-root paths, and gateway state', async () => {    const relative = await fetch(`http://127.0.0.1:${port}/__webim/fs?path=hello.txt`, { headers: { cookie, 'user-agent': TEST_UA } })
    assert.equal(relative.status, 400)

    const outside = await fetch(`http://127.0.0.1:${port}/__webim/fs?path=${encodeURIComponent(tmpdir())}`, {
      headers: { cookie, 'user-agent': TEST_UA },
    })
    assert.equal(outside.status, 403)

    const state = await fetch(`http://127.0.0.1:${port}/__webim/fs?path=${encodeURIComponent(stateDir)}`, {
      headers: { cookie, 'user-agent': TEST_UA },
    })
    assert.equal(state.status, 403)
  })

  it('requires a session for the file view and client assets', async () => {
    const fsResponse = await fetch(`http://127.0.0.1:${port}/__webim/fs?path=${encodeURIComponent(fsRoot)}`, {
      redirect: 'manual',
    })
    assert.equal(fsResponse.status, 401)
    const assetResponse = await fetch(`http://127.0.0.1:${port}/__webim/client.js`, { redirect: 'manual' })
    assert.equal(assetResponse.status, 401)
  })

  it('reports status with warnings for the default weak password', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/__webim/api/status`, { headers: { cookie, 'user-agent': TEST_UA } })
    assert.equal(response.status, 200)
    const status = await response.json()
    assert.equal(status.ok, true)
    assert.equal(status.auth.weakPassword, true)
    assert.equal(status.files.enabled, true)
    assert.match(status.upstream, /^http:\/\/127\.0\.0\.1:\d+$/u)
  })

  it('logs out and invalidates the browser session', async () => {
    const result = await fetch(`http://127.0.0.1:${port}/__webim/logout`, {
      method: 'POST',
      headers: { cookie, origin: `http://127.0.0.1:${port}` },
      redirect: 'manual',
    })
    assert.equal(result.status, 303)
    assert.equal(result.headers.get('location'), '/__webim/login')
    assert.match(result.headers.getSetCookie()[0], /Max-Age=0/u)
    // The stateless token itself remains valid; clearing is the browser's job.
    const still = await fetch(`http://127.0.0.1:${port}/__webim/api/status`, { headers: { cookie, 'user-agent': TEST_UA } })
    assert.equal(still.status, 200)
  })

  it('blocks an address after repeated wrong passwords', async () => {
    const stateDir2 = await mkdtemp(join(tmpdir(), 'webim-lock-'))
    const locked = createGateway({
      config: { host: '127.0.0.1', port: 0, password: '124', stateDir: stateDir2, maxFailures: 3, blockMinutes: 15 },
      upstreamOrigin: `http://127.0.0.1:${upstreamInfo.port}`,
      getCookie: async () => 'UPSTREAM_SESSION=abc',
      invalidateCookie: () => {},
      log: () => {},
    })
    const address = await locked.listen()
    try {
      const first = await login(address.port, 'bad')
      assert.equal(first.response.status, 401)
      const second = await login(address.port, 'bad')
      assert.equal(second.response.status, 401)
      const third = await login(address.port, 'bad')
      assert.equal(third.response.status, 429)
      assert.ok(Number(third.response.headers.get('retry-after')) > 0)
      const correctWhileBlocked = await login(address.port, '124')
      assert.equal(correctWhileBlocked.response.status, 429)
      assert.equal(correctWhileBlocked.setCookie, '')
    } finally {
      await locked.close()
      await rm(stateDir2, { recursive: true, force: true })
    }
  })
})
