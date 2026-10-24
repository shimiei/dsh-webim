import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

/** A stand-in for the local Harness web carrier: mints its session cookie on /__auth. */
function createUpstream() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/__auth')) {
      res.writeHead(200, { 'set-cookie': 'harness-session=minted; Path=/; HttpOnly', 'content-type': 'text/plain' })
      res.end('ok')
      return
    }
    if (req.url === '/' || req.url.startsWith('/?')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><body>host-test-harness</body></html>')
      return
    }
    if (req.url.startsWith('/api/echo')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? '', host: req.headers.host }))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  return server
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address())))
}

/** Reserve a port for the gateway (config needs a concrete number). */
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

/** Minimal Cordis Context with only the faces lib/index.js reads. */
function createContext() {
  const disposers = []
  const calls = []
  const registeredRoutes = []
  const ctx = {
    logger: { info: () => {}, debug: () => {}, warn: () => {} },
    effect(fn, _label) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            registeredRoutes.push(route)
            return () => {}
          },
          getOrigin() {
            return ctx.upstreamOrigin
          },
        }
      }
      if (name === 'connection') return ctx.connection
      return undefined
    },
    upstreamOrigin: '',
    connection: {
      rpc: {
        handle(channel, handler) {
          calls.push({ channel, handler })
          return () => {}
        },
      },
      authenticatedUrl(base) {
        const url = new URL(base)
        url.pathname = '/__auth'
        url.searchParams.set('token', 'launch-token')
        return url.toString()
      },
      requestRejection() {
        return undefined
      },
    },
  }
  return { ctx, calls, registeredRoutes, dispose: () => Promise.all(disposers.reverse().map((fn) => Promise.resolve(fn()))) }
}

async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const value = await check()
      if (value) return value
    } catch {
      // keep polling
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for the remote entry')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function ping(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__webim/ping`, { redirect: 'manual' })
    return response.ok
  } catch {
    return false
  }
}

async function startHost({ config = {}, upstreamPort }) {
  const stateDir = await mkdtemp(join(tmpdir(), 'webim-host-'))
  const port = await freePort()
  const { ctx, calls, registeredRoutes, dispose } = createContext()
  ctx.upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  apply(ctx, {
    host: '127.0.0.1',
    port,
    password: '124',
    stateDir,
    ...config,
  })
  const stop = async () => {
    await dispose()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  try {
    await waitFor(() => ping(port))
    const channel = calls.find((entry) => entry.channel === '/webim')
    if (!channel) throw new Error('the host half must register the /webim channel')
    return { stateDir, port, rpc: (endpoint, payload) => channel.handler(endpoint, payload), registeredRoutes, dispose: stop }
  } catch (error) {
    await stop()
    throw error
  }
}

function cookieOf(response) {
  return (response.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? ''
}

describe('dsh-webim host plugin', () => {
  let upstream
  let upstreamInfo

  after(async () => {
    if (!upstream) return
    await new Promise((resolve) => {
      upstream.close(resolve)
      upstream.closeAllConnections?.()
    })
  })

  it('starts the remote entry from the plugin context and answers its settings RPC', async () => {
    upstream = createUpstream()
    upstreamInfo = await listen(upstream)
    const host = await startHost({ upstreamPort: upstreamInfo.port })
    try {
      const info = await host.rpc('info', {})
      assert.equal(info.ok, true)
      const value = info.value
      assert.equal(value.version, (await import('../lib/version.js')).VERSION)
      assert.equal(value.gateway.running, true)
      assert.equal(value.gateway.port, host.port)
      assert.equal(value.gateway.upstream, `http://127.0.0.1:${upstreamInfo.port}`)
      assert.equal(value.access.token.length, 43)
      assert.equal(value.access.tokenConfigured, false)
      assert.ok(value.access.urls.length >= 1)
      const primary = value.access.urls[0]
      // No loopback entry any more: the owner is already inside the app.
      assert.equal(primary.kind, 'lan')
      assert.match(primary.tokenUrl, /^http:\/\/.+:\d+\/\?token=[A-Za-z0-9_-]{43}$/u)
      assert.ok(value.access.urls[0].tokenUrl.includes(`:${host.port}/`))
      assert.equal(value.access.urls.some((entry) => entry.id === 'local'), false)
      assert.ok(value.access.qr)
      assert.match(value.access.qr.svg, /^<svg /u)
      assert.equal(value.access.qr.size, value.access.qr.version * 4 + 17)
      assert.equal(value.security.weakPassword, true)
      assert.equal(value.security.passwordLength, 3)

      // The entry link works end to end: it mints a session, then the proxy
      // authenticates upstream with the cookie it acquired from the Harness.
      const entered = await fetch(`http://127.0.0.1:${host.port}/?token=${value.access.token}`, { redirect: 'manual' })
      assert.equal(entered.status, 303)
      assert.equal(entered.headers.get('location'), '/')
      const cookie = cookieOf(entered)
      assert.ok(cookie.startsWith('dsh_webim='))
      const page = await fetch(`http://127.0.0.1:${host.port}/`, { headers: { cookie } })
      assert.equal(page.status, 200)
      assert.match(await page.text(), /host-test-harness/u)
      const echo = await fetch(`http://127.0.0.1:${host.port}/api/echo`, { headers: { cookie } })
      const payload = await echo.json()
      assert.equal(payload.cookie.split(';')[0], 'harness-session=minted')
      assert.ok(!payload.cookie.includes('dsh_webim'))
      assert.equal(payload.host, `127.0.0.1:${upstreamInfo.port}`)

      // Diagnostics: ping names the generation that answers, and the start
      // record mirrors the token on disk so a rejected link can be traced.
      const pingPayload = await (await fetch(`http://127.0.0.1:${host.port}/__webim/ping`)).json()
      assert.equal(
        pingPayload.instance.tokenId,
        createHash('sha256').update(value.access.token).digest('hex').slice(0, 10),
      )
      const startRecord = JSON.parse(await readFile(join(host.stateDir, 'last-start.json'), 'utf8'))
      assert.equal(startRecord.token, value.access.token)
      assert.equal(startRecord.stateDir, host.stateDir)
      assert.equal(startRecord.pinned, false)
      assert.equal(startRecord.tokenError, '')
      assert.equal(startRecord.port, host.port)

      // Settings: the token rotates, and the public address pins the QR target.
      const refreshed = await host.rpc('refresh', {})
      assert.equal(refreshed.ok, true)
      assert.notEqual(refreshed.value.access.token, value.access.token)
      const oldLink = await fetch(`http://127.0.0.1:${host.port}/?token=${value.access.token}`, { redirect: 'manual' })
      assert.equal(oldLink.status, 401)
      const newLink = await fetch(`http://127.0.0.1:${host.port}/?token=${refreshed.value.access.token}`, { redirect: 'manual' })
      assert.equal(newLink.status, 303)

      // Refreshing also drops the sessions the old link created: the cookie from
      // before the rotation no longer authenticates.
      const staleSession = await fetch(`http://127.0.0.1:${host.port}/`, { headers: { cookie }, redirect: 'manual' })
      assert.equal(staleSession.status, 401)

      // Feature switches apply at runtime and are persisted for the next boot.
      const features = await host.rpc('setFeatures', { features: { mobileUi: false, fileBrowser: false } })
      assert.equal(features.ok, true)
      assert.equal(features.value.features.values.mobileUi, false)
      assert.equal(features.value.features.values.fileBrowser, false)
      const storedFeatures = JSON.parse(await readFile(join(host.stateDir, 'features.json'), 'utf8'))
      assert.equal(storedFeatures.features.mobileUi, false)
      const freshSession = cookieOf(await fetch(`http://127.0.0.1:${host.port}/?token=${refreshed.value.access.token}`, { redirect: 'manual' }))
      const fsBlocked = await fetch(`http://127.0.0.1:${host.port}/__webim/fs?path=`, { headers: { cookie: freshSession } })
      assert.equal(fsBlocked.status, 403)
      const reset = await host.rpc('resetFeatures', {})
      assert.equal(reset.value.features.values.fileBrowser, true)

      const pinned = await host.rpc('setPublicUrl', { url: '  https://dsh.example.com/  ' })
      assert.equal(pinned.ok, true)
      assert.equal(pinned.value.publicAddress.current, 'https://dsh.example.com')
      assert.equal(pinned.value.access.urls[0].id, 'public')
      assert.match(pinned.value.access.urls[0].tokenUrl, /^https:\/\/dsh\.example\.com\/\?token=/u)
      assert.equal(pinned.value.access.qr.size, pinned.value.access.qr.version * 4 + 17)
      const saved = await readFile(join(host.stateDir, 'public-url.txt'), 'utf8')
      assert.equal(saved.trim(), 'https://dsh.example.com')

      const cleared = await host.rpc('setPublicUrl', { url: '' })
      assert.equal(cleared.value.publicAddress.current, '')

      const anonymous = await fetch(`http://127.0.0.1:${host.port}/__webim/api/status`, { redirect: 'manual' })
      assert.equal(anonymous.status, 401)
      const stored = JSON.parse(await readFile(join(host.stateDir, 'token.json'), 'utf8'))
      assert.equal(stored.token, cleared.value.access.token)
    } finally {
      await host.dispose()
    }
    await waitFor(async () => !(await ping(host.port)), 5000)
  })

  it('honors a pinned token and refuses to rotate it', async () => {
    upstream ??= createUpstream()
    upstreamInfo ??= await listen(upstream)
    const pinnedToken = 'p'.repeat(20) + 'Q'.repeat(23)
    const host = await startHost({ upstreamPort: upstreamInfo.port, config: { accessToken: pinnedToken } })
    try {
      const info = await host.rpc('info', {})
      assert.equal(info.value.access.token, pinnedToken)
      assert.equal(info.value.access.tokenConfigured, true)
      assert.equal(info.value.access.urls[0].tokenUrl.endsWith(`?token=${pinnedToken}`), true)
      const refresh = await host.rpc('refresh', {})
      assert.equal(refresh.ok, false)
      assert.equal(refresh.error.code, 'token-pinned')
      const entered = await fetch(`http://127.0.0.1:${host.port}/?token=${pinnedToken}`, { redirect: 'manual' })
      assert.equal(entered.status, 303)
    } finally {
      await host.dispose()
    }
  })

  it('answers unknown endpoints with a structured failure', async () => {
    upstream ??= createUpstream()
    upstreamInfo ??= await listen(upstream)
    const host = await startHost({ upstreamPort: upstreamInfo.port })
    try {
      const unknown = await host.rpc('nope', {})
      assert.equal(unknown.ok, false)
      assert.equal(unknown.error.code, 'not-found')
      assert.deepEqual(unknown.error.details, {})
      const badUrl = await host.rpc('setPublicUrl', { url: 'ftp://nope' })
      assert.equal(badUrl.ok, true)
      assert.equal(badUrl.value.publicAddress.current, '')
      const noGatewayDependency = host.registeredRoutes.every((route) => route.path !== '/webim')
      assert.equal(noGatewayDependency, true, 'the primary path must use connection.rpc.handle, not a web route')
    } finally {
      await host.dispose()
    }
  })

  it('lets the owner choose which entry the QR code carries', async () => {
    upstream ??= createUpstream()
    upstreamInfo ??= await listen(upstream)
    const host = await startHost({ upstreamPort: upstreamInfo.port, config: { publicUrl: 'https://dsh.example.com' } })
    try {
      const before = await host.rpc('info', {})
      // The public address outranks the LAN entries, so it is the default target.
      assert.equal(before.value.access.qrTargetId, 'public')
      assert.equal(before.value.access.urls[0].isQrTarget, true)

      const lanEntry = before.value.access.urls.find((entry) => entry.kind === 'lan')
      assert.ok(lanEntry, 'the test host needs at least one LAN entry')
      const picked = await host.rpc('setQrTarget', { id: lanEntry.id })
      assert.equal(picked.ok, true)
      assert.equal(picked.value.access.qrTargetId, lanEntry.id)
      const marked = picked.value.access.urls.filter((entry) => entry.isQrTarget)
      assert.equal(marked.length, 1)
      assert.equal(marked[0].id, lanEntry.id)
      // The QR now encodes the LAN link, not the public one.
      assert.ok(picked.value.access.qr)
      assert.equal(picked.value.access.qr.size, picked.value.access.qr.version * 4 + 17)

      const stored = (await readFile(join(host.stateDir, 'qr-target.txt'), 'utf8')).trim()
      assert.equal(stored, lanEntry.id)

      const bogus = await host.rpc('setQrTarget', { id: 'lan:203.0.113.9' })
      assert.equal(bogus.ok, false)
      assert.equal(bogus.error.code, 'unknown-entry')

      // Clearing falls back to the first entry again.
      const cleared = await host.rpc('setQrTarget', { id: '' })
      assert.equal(cleared.value.access.qrTargetId, 'public')
    } finally {
      await host.dispose()
    }
  })

  it('stops listening entirely while the master switch is off, and comes back', async () => {
    upstream ??= createUpstream()
    upstreamInfo ??= await listen(upstream)
    const host = await startHost({ upstreamPort: upstreamInfo.port })
    try {
      const off = await host.rpc('setFeatures', { features: { enabled: false } })
      assert.equal(off.ok, true)
      // The reply is immediate; the listener is torn down right after it, so the
      // Settings panel never has to wait for a socket drain.
      assert.equal(off.value.gateway.disabled, true)
      assert.deepEqual(off.value.access.urls, [], 'a switched-off entry must advertise no links')
      assert.equal(off.value.access.qr, null)

      await waitFor(async () => (await host.rpc('info', {})).value.gateway.running === false, 8000)
      await waitFor(async () => !(await ping(host.port)), 8000)
      assert.equal(await ping(host.port), false, 'the port must be closed, not just refusing links')
      const entry = await fetch(`http://127.0.0.1:${host.port}/?token=x`, { redirect: 'manual' }).then((r) => r.status, () => 0)
      assert.equal(entry, 0, 'nothing answers on the port while the master switch is off')

      const on = await host.rpc('setFeatures', { features: { enabled: true } })
      assert.equal(on.value.gateway.disabled, false)
      await waitFor(async () => (await host.rpc('info', {})).value.gateway.running === true, 8000)
      await waitFor(() => ping(host.port), 8000)
      assert.equal(await ping(host.port), true)
      const back = (await host.rpc('info', {})).value
      assert.ok(back.access.urls.length >= 1)
      assert.equal(back.access.urls[0].tokenUrl.includes(`:${host.port}/`), true)
    } finally {
      await host.dispose()
    }
  })

  it('binds loopback and stops advertising LAN links when the LAN entry is off', async () => {
    upstream ??= createUpstream()
    upstreamInfo ??= await listen(upstream)
    const host = await startHost({ upstreamPort: upstreamInfo.port, config: { host: '0.0.0.0' } })
    try {
      const widely = await host.rpc('info', {})
      assert.equal(widely.value.gateway.host, '0.0.0.0')
      assert.equal(widely.value.reach.lan, true)

      const off = await host.rpc('setFeatures', { features: { lan: false } })
      assert.equal(off.ok, true)
      assert.equal(off.value.reach.lan, false)
      assert.equal(off.value.gateway.host, '127.0.0.1', 'the listener must rebind to loopback')
      assert.equal(off.value.access.urls.some((entry) => entry.kind === 'lan'), false)
      await waitFor(() => ping(host.port), 8000)

      const back = await host.rpc('setFeatures', { features: { lan: true } })
      assert.equal(back.value.gateway.host, '0.0.0.0')
      assert.ok(back.value.access.urls.some((entry) => entry.kind === 'lan'))
      await waitFor(() => ping(host.port), 8000)
    } finally {
      await host.dispose()
    }
  })

  it('keeps the tunnel independent from the public address', async () => {
    upstream ??= createUpstream()
    upstreamInfo ??= await listen(upstream)
    const host = await startHost({
      upstreamPort: upstreamInfo.port,
      // No cloudflared in the test environment: refuse to download, so flipping
      // the tunnel switch cannot reach the network or spawn a real tunnel.
      config: { publicUrl: 'https://dsh.example.com', tunnelBinary: join(tmpdir(), 'no-cloudflared'), tunnelAutoInstall: false },
    })
    try {
      const before = await host.rpc('info', {})
      assert.equal(before.value.access.urls[0].id, 'public')

      // Turning the saved public address off must not take the tunnel with it.
      const off = await host.rpc('setFeatures', { features: { public: false } })
      assert.equal(off.ok, true)
      assert.equal(off.value.reach.public, false)
      assert.equal(off.value.reach.tunnel, false)
      assert.ok(off.value.access.urls.every((entry) => entry.kind === 'lan'))

      // `tunnelStart` is refused only by its own switch, not by the public one.
      const refused = await host.rpc('tunnelStart', {})
      assert.equal(refused.ok, false)
      assert.equal(refused.error.code, 'tunnel-off')

      const tunnelOn = await host.rpc('setFeatures', { features: { tunnel: true } })
      assert.equal(tunnelOn.value.reach.public, false)
      assert.equal(tunnelOn.value.reach.tunnel, true)
      // The switch is on but cloudflared is not running yet (this host has no
      // binary), so the list still has no tunnel entry — and nothing spawned.
      assert.equal(tunnelOn.value.tunnel.running, false)
      assert.equal(tunnelOn.value.tunnel.starting, false)
      assert.ok(tunnelOn.value.access.urls.every((entry) => entry.kind === 'lan'))

      const back = await host.rpc('setFeatures', { features: { public: true } })
      assert.equal(back.value.access.urls[0].id, 'public')
      assert.equal(back.value.reach.tunnel, true)
    } finally {
      await host.dispose()
    }
  })
})
