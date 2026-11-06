import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGateway } from '../lib/gateway.js'
import { normalizeConfig } from '../lib/config.js'
import {
  PairingStore,
  createDeviceToken,
  createPairingCode,
  formatPairCode,
  looksLikeDeviceToken,
  looksLikePairCode,
  normalizePairCode,
} from '../lib/pairing.js'

const DAY = 24 * 60 * 60 * 1000

function createUpstream() {
  const state = { requests: [], upgrades: [] }
  const server = http.createServer((req, res) => {
    state.requests.push({ url: req.url, headers: req.headers })
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>Harness</title></head><body>hello-harness</body></html>')
  })
  server.on('upgrade', (req, socket) => {
    state.upgrades.push({ url: req.url, headers: req.headers })
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fake-accept\r\n\r\n',
    )
    // A real WebSocket endpoint closes when its peer goes away; the bare TCP
    // socket used here stays half-open without this, and then upstream.close()
    // never finishes.
    socket.on('error', () => socket.destroy())
    socket.on('end', () => socket.destroy())
    socket.on('close', () => socket.destroy())
  })
  return { server, state }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address())))
}

function cookies(response) {
  return response.headers.getSetCookie?.() ?? []
}

/** Sessions are pinned to a User-Agent, so every authenticated request carries one. */
const TEST_UA = 'IMDSH-test/1.0 (iPhone)'

async function login(port, password) {
  const response = await fetch(`http://127.0.0.1:${port}/__webim/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': TEST_UA },
    body: new URLSearchParams({ password, next: '/' }).toString(),
  })
  return cookies(response)[0]?.split(';')[0] ?? ''
}

/** Open a WebSocket-shaped upgrade and report the status line. */
function rawUpgrade(port, path, cookie) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
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
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const index = buffer.indexOf('\r\n\r\n')
      if (index === -1) return
      clearTimeout(timer)
      socket.destroy()
      resolve(buffer.subarray(0, index).toString('latin1'))
    })
    socket.on('error', reject)
  })
}

describe('pairing codes and device tokens', () => {
  let stateDir

  before(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'webim-pairing-'))
  })

  after(async () => {
    await rm(stateDir, { recursive: true, force: true })
  })

  it('mints codes in the XXXX-XXXX-XXXX shape without confusing characters', () => {
    const code = createPairingCode()
    assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/u)
    assert.equal(code.length, 14)
    // 0/O, 1/I/L, U and the digit-lookalike letters are all absent.
    for (const banned of ['0', 'O', '1', 'I', 'L', 'U', 'B', 'G', 'S', 'Z']) {
      assert.equal(code.includes(banned), false, `${banned} must not appear in a pairing code`)
    }
    assert.equal(looksLikePairCode(code), true)
    // The owner may type it lower case, with spaces, or without separators.
    assert.equal(normalizePairCode(code.toLowerCase().replaceAll('-', ' ')), normalizePairCode(code))
    assert.equal(looksLikePairCode(normalizePairCode(code)), true)
    assert.equal(formatPairCode(normalizePairCode(code)), code)
    assert.equal(looksLikePairCode('nope'), false)
    assert.equal(looksLikePairCode('ABC0-DEFG-HJKM'), false)
    // Fresh codes never collide in practice.
    assert.notEqual(createPairingCode(), createPairingCode())
  })

  it('mints 32-byte base64url device tokens', () => {
    const token = createDeviceToken()
    assert.equal(token.length, 43)
    assert.match(token, /^[A-Za-z0-9_-]{43}$/u)
    assert.equal(looksLikeDeviceToken(token), true)
    assert.equal(Buffer.from(token, 'base64url').length, 32)
    assert.equal(looksLikeDeviceToken('short'), false)
    assert.equal(looksLikeDeviceToken(''), false)
  })

  it('binds one code to one device and reuses the token on the same device', () => {
    const store = new PairingStore({ stateDir: join(stateDir, 'bind') })
    const record = store.createCode()
    assert.equal(record.expiresAt - record.createdAt, 30 * DAY, 'the default lifetime is 30 days')

    const first = store.redeem({ code: record.code, deviceId: 'iphone-A', name: 'iPhone 15', platform: 'ios' })
    assert.equal(first.ok, true)
    assert.equal(first.reused, false)
    assert.equal(first.deviceToken.length, 43)
    assert.equal(first.device.deviceId, 'iphone-A')
    assert.equal(first.device.name, 'iPhone 15')
    assert.equal(first.device.platform, 'ios')
    assert.equal(first.device.revoked, false)

    // Reinstalled app, same deviceId: the very same token comes back.
    const again = store.redeem({ code: record.code, deviceId: 'iphone-A' })
    assert.equal(again.ok, true)
    assert.equal(again.reused, true)
    assert.equal(again.deviceToken, first.deviceToken)
    assert.equal(store.listDevices().length, 1)

    // A different device must not be able to ride along.
    const other = store.redeem({ code: record.code, deviceId: 'iphone-B' })
    assert.equal(other.ok, false)
    assert.equal(other.code, 'code-already-bound')
    assert.equal(store.listDevices().length, 1)

    // Unknown and malformed codes are refused, and never create a device.
    assert.equal(store.redeem({ code: 'AAAA-BBBB-CCCC', deviceId: 'iphone-B' }).code, 'code-invalid')
    assert.equal(store.redeem({ code: record.code, deviceId: '' }).code, 'bad-request')
  })

  it('rejects an expired code and accepts a permanent one', () => {
    const store = new PairingStore({ stateDir: join(stateDir, 'expiry'), pairDays: 30 })
    const start = Date.now()
    const short = store.createCode({ days: 1, now: start })
    assert.equal(short.expiresAt, start + DAY)
    const expired = store.redeem({ code: short.code, deviceId: 'device-1', now: start + DAY + 1 })
    assert.equal(expired.ok, false)
    assert.equal(expired.code, 'code-expired')

    const permanent = store.createCode({ days: 0, now: start })
    assert.equal(permanent.expiresAt, 0, 'days: 0 means it never expires')
    const later = store.redeem({ code: permanent.code, deviceId: 'device-2', now: start + 3650 * DAY })
    assert.equal(later.ok, true)
    const listed = store.listCodes(start + DAY)
    assert.equal(listed.find((entry) => entry.code === permanent.code).permanent, true)
    assert.equal(listed.find((entry) => entry.code === short.code).expired, true)
  })

  it('revoking a code stops redemption, revoking a device kills its token', () => {
    const store = new PairingStore({ stateDir: join(stateDir, 'revoke') })
    const record = store.createCode()
    const redeemed = store.redeem({ code: record.code, deviceId: 'device-1' })
    assert.ok(store.authenticateDevice(redeemed.deviceToken), 'the fresh token opens the gate')

    assert.equal(store.authenticateDevice(createDeviceToken()), null, 'a random token is not a credential')

    const revoked = store.revokeDevice({ deviceId: 'device-1' })
    assert.equal(revoked.ok, true)
    assert.equal(revoked.device.revoked, true)
    assert.equal(store.authenticateDevice(redeemed.deviceToken), null, 'a revoked token stops working at once')
    // A revoked device does not come back by redeeming the same code again.
    const revive = store.redeem({ code: record.code, deviceId: 'device-1' })
    assert.equal(revive.ok, false)
    assert.equal(revive.code, 'device-revoked')
    assert.equal(store.isDeviceActive('device-1'), false)

    // An unused code can be revoked before anybody redeems it.
    const unused = store.createCode()
    assert.equal(store.revokeCode({ code: unused.code }).ok, true)
    const attempted = store.redeem({ code: unused.code, deviceId: 'device-2' })
    assert.equal(attempted.ok, false)
    assert.equal(attempted.code, 'code-invalid')
    assert.equal(store.revokeCode({ code: unused.code }).ok, true, 'revoking twice is harmless')
    assert.equal(store.revokeDevice({ deviceId: 'no-such-device' }).code, 'unknown-device')
  })

  it('lets a revoked device pair again with a code minted afterwards', () => {
    const store = new PairingStore({ stateDir: join(stateDir, 'repair') })
    const first = store.createCode()
    const paired = store.redeem({ code: first.code, deviceId: 'device-1' })
    assert.equal(store.revokeDevice({ deviceId: 'device-1' }).ok, true)
    assert.equal(store.authenticateDevice(paired.deviceToken), null)

    // The code it was paired with is spent: it must not resurrect the device.
    const reuse = store.redeem({ code: first.code, deviceId: 'device-1' })
    assert.equal(reuse.ok, false)
    assert.equal(reuse.code, 'device-revoked')

    // A code minted after the revocation does re-pair it, with a brand new token.
    const fresh = store.createCode()
    const again = store.redeem({ code: fresh.code, deviceId: 'device-1' })
    assert.equal(again.ok, true)
    assert.equal(again.reused, false)
    assert.notEqual(again.deviceToken, paired.deviceToken, 'the revoked token stays dead')
    assert.ok(store.authenticateDevice(again.deviceToken))
    assert.equal(store.listDevices().length, 1)
    assert.equal(store.listDevices()[0].revoked, false)
  })

  it('writes pairing.json atomically and reloads it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'webim-pairing-file-'))
    try {
      const store = new PairingStore({ stateDir: dir })
      const record = store.createCode()
      const redeemed = store.redeem({ code: record.code, deviceId: 'device-1', name: 'iPhone' })
      const file = join(dir, 'pairing.json')
      const saved = JSON.parse(await readFile(file, 'utf8'))
      assert.equal(saved.version, 1)
      assert.equal(saved.codes.length, 1)
      assert.equal(saved.codes[0].deviceId, 'device-1')
      assert.equal(saved.devices.length, 1)
      assert.equal(saved.devices[0].token, redeemed.deviceToken)
      // The temp file is renamed away, never left behind.
      await assert.rejects(() => stat(`${file}.tmp`), /ENOENT/u)
      if (process.platform !== 'win32') {
        const info = await stat(file)
        assert.equal(info.mode & 0o777, 0o600, 'pairing.json is owner read/write only')
      }

      // A fresh store in the same directory picks the table up again.
      const reloaded = new PairingStore({ stateDir: dir })
      assert.equal(reloaded.lastError, '')
      assert.equal(reloaded.listDevices().length, 1)
      assert.ok(reloaded.authenticateDevice(redeemed.deviceToken), 'a paired device survives a restart')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('degrades to an empty table when pairing.json is damaged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'webim-pairing-broken-'))
    try {
      const logs = []
      await writeFile(join(dir, 'pairing.json'), '{ this is not json', 'utf8')
      const broken = new PairingStore({ stateDir: dir, log: (line) => logs.push(line) })
      assert.match(broken.lastError, /pairing\.json unreadable/u)
      assert.equal(logs.length, 1)
      assert.deepEqual(broken.listDevices(), [])
      assert.deepEqual(broken.listCodes(), [])
      // The store is still usable, and the next write repairs the file.
      const record = broken.createCode()
      assert.equal(broken.redeem({ code: record.code, deviceId: 'device-1' }).ok, true)
      const repaired = new PairingStore({ stateDir: dir })
      assert.equal(repaired.lastError, '')
      assert.equal(repaired.listDevices().length, 1)

      // A file that parses but is not ours is treated the same way.
      await writeFile(join(dir, 'pairing.json'), '{"version":99,"codes":{}}', 'utf8')
      const foreign = new PairingStore({ stateDir: dir })
      assert.match(foreign.lastError, /unexpected shape/u)
      assert.equal(foreign.info().devices, 0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the pairing lifetime configurable, 0 meaning permanent', () => {
    assert.equal(normalizeConfig({ pairDays: 7 }).pairDays, 7)
    assert.equal(normalizeConfig({ pairDays: 0 }).pairDays, 0)
    assert.equal(normalizeConfig({}).pairDays, 30)
    assert.equal(normalizeConfig({ pairDays: -5 }).pairDays, 30, 'a negative lifetime falls back to the default')
    const store = new PairingStore({ stateDir: join(stateDir, 'days'), pairDays: 0 })
    assert.equal(store.createCode().expiresAt, 0)
  })
})

/** Reserve a port for the host plugin (its config wants a concrete number). */
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
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    get(name) {
      if (name === 'webServer') {
        return { register: () => () => {}, getOrigin: () => ctx.upstreamOrigin }
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
      authenticatedUrl: () => '',
      requestRejection: () => undefined,
    },
  }
  return { ctx, calls, dispose: () => Promise.all(disposers.reverse().map((fn) => Promise.resolve(fn()))) }
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

/** Run the plugin host half and hand back its settings RPC. */
async function startHost(upstreamPort) {
  const stateDir = await mkdtemp(join(tmpdir(), 'webim-pairing-host-'))
  const port = await freePort()
  const { ctx, calls, dispose } = createContext()
  ctx.upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const { apply } = await import('../lib/index.js')
  apply(ctx, { host: '127.0.0.1', port, password: '124', stateDir })
  const stop = async () => {
    await dispose()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await rm(stateDir, { recursive: true, force: true })
  }
  try {
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/__webim/ping`, { redirect: 'manual' })).ok
      } catch {
        return false
      }
    })
    const channel = calls.find((entry) => entry.channel === '/webim')
    if (!channel) throw new Error('the host half must register the /webim channel')
    return { port, stateDir, rpc: (endpoint, payload) => channel.handler(endpoint, payload), dispose: stop }
  } catch (error) {
    await stop()
    throw error
  }
}

describe('device pairing over the settings RPC', () => {
  it('mints, lists and revokes through the shared /webim channel', async () => {
    const upstream = createUpstream()
    const upstreamInfo = await listen(upstream.server)
    const host = await startHost(upstreamInfo.port)
    try {
      const before = await host.rpc('info', {})
      assert.equal(before.ok, true)
      assert.deepEqual(before.value.pairing.devices, [])
      assert.deepEqual(before.value.pairing.codes, [])
      assert.equal(before.value.pairing.pairDays, 30)

      const made = await host.rpc('pairCode', {})
      assert.equal(made.ok, true)
      const code = made.value.pairing.created.code
      assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/u)
      assert.equal(made.value.pairing.created.permanent, false)
      assert.ok(made.value.pairing.created.expiresInDays >= 29)
      assert.equal(made.value.pairing.codes.length, 1)

      // The code redeems through the public endpoint, and the panel then sees
      // the device — both halves share one store, so no restart is needed.
      const redeemed = await fetch(`http://127.0.0.1:${host.port}/__webim/pair/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, deviceId: 'IMDSH-RPC-1', name: 'iPhone', platform: 'ios' }),
      })
      const paired = await redeemed.json()
      assert.equal(paired.ok, true)
      const listed = await host.rpc('info', {})
      const device = listed.value.pairing.devices[0]
      assert.equal(device.deviceId, 'IMDSH-RPC-1')
      assert.equal(device.name, 'iPhone')
      assert.equal(listed.value.pairing.codes[0].redeemed, true)

      const revoked = await host.rpc('pairRevoke', { deviceId: 'IMDSH-RPC-1' })
      assert.equal(revoked.ok, true)
      assert.equal(revoked.value.pairing.devices[0].revoked, true)
      const rejected = await fetch(`http://127.0.0.1:${host.port}/`, {
        headers: { cookie: `webim_device=${paired.deviceToken}` },
      })
      assert.equal(rejected.status, 401, 'revoking from the panel kills the live token')

      const missing = await host.rpc('pairRevoke', { deviceId: 'nope' })
      assert.equal(missing.ok, false)
      assert.equal(missing.error.code, 'unknown-device')
      const both = await host.rpc('pairRevoke', { deviceId: 'a', code })
      assert.equal(both.ok, false)
      assert.equal(both.error.code, 'bad-request')
      const tooLong = await host.rpc('pairCode', { days: 4000 })
      assert.equal(tooLong.ok, false)
      assert.equal(tooLong.error.code, 'bad-request')

      // An unused code can be dropped from the list as well.
      const spare = await host.rpc('pairCode', {})
      const dropped = await host.rpc('pairRevoke', { code: spare.value.pairing.created.code })
      assert.equal(dropped.ok, true)
      assert.equal(dropped.value.pairing.codes.filter((entry) => entry.revoked !== true).length, 1)
    } finally {
      await host.dispose()
      await new Promise((resolve) => {
        upstream.server.close(resolve)
        upstream.server.closeAllConnections?.()
      })
    }
  })
})

describe('device pairing over HTTP', () => {
  let stateDir
  let upstream
  let upstreamInfo
  let gateway
  let port
  let cookie

  before(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'webim-pairing-http-'))
    upstream = createUpstream()
    upstreamInfo = await listen(upstream.server)
    gateway = createGateway({
      config: { host: '127.0.0.1', port: 0, password: '124', stateDir, maxFailures: 100 },
      upstreamOrigin: `http://127.0.0.1:${upstreamInfo.port}`,
      getCookie: async () => 'UPSTREAM_SESSION=abc',
      invalidateCookie: () => {},
      log: () => {},
    })
    port = (await gateway.listen()).port
    cookie = await login(port, '124')
    assert.ok(cookie.startsWith('dsh_webim='))
  })

  after(async () => {
    await gateway?.close()
    await new Promise((resolve) => {
      upstream.server.close(resolve)
      upstream.server.closeAllConnections?.()
    })
    await rm(stateDir, { recursive: true, force: true })
  })

  function post(path, body, headers = {}) {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', 'user-agent': TEST_UA, ...headers },
      body: JSON.stringify(body),
    })
  }

  it('requires a session to mint or list pairing state', async () => {
    const anonymousCode = await post('/__webim/pair/code', {})
    assert.equal(anonymousCode.status, 401)
    // Native clients get JSON, never the browser login page.
    assert.deepEqual(await anonymousCode.json(), { ok: false, error: 'login required' })
    const anonymousList = await fetch(`http://127.0.0.1:${port}/__webim/pair/devices`, { headers: { 'user-agent': TEST_UA } })
    assert.equal(anonymousList.status, 401)
    assert.deepEqual(await anonymousList.json(), { ok: false, error: 'login required' })
    const anonymousRevoke = await post('/__webim/pair/revoke', { deviceId: 'x' })
    assert.equal(anonymousRevoke.status, 401)

    const created = await post('/__webim/pair/code', {}, { cookie })
    assert.equal(created.status, 200)
    const payload = await created.json()
    assert.equal(payload.ok, true)
    assert.match(payload.pairingCode.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/u)
    assert.equal(payload.pairingCode.permanent, false)
    assert.ok(payload.pairingCode.expiresInDays >= 29)
    // A lifetime outside the allowed range is refused instead of clamped silently.
    const tooLong = await post('/__webim/pair/code', { days: 99999 }, { cookie })
    assert.equal(tooLong.status, 400)
  })

  it('redeems a code anonymously and opens the gate with the device token', async () => {
    const created = await (await post('/__webim/pair/code', {}, { cookie })).json()
    const code = created.pairingCode.code

    const redeemed = await post('/__webim/pair/redeem', {
      code: code.toLowerCase(),
      deviceId: 'IMDSH-DEVICE-1',
      name: 'iPhone 15 Pro',
      platform: 'ios',
    })
    assert.equal(redeemed.status, 200)
    const payload = await redeemed.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.deviceId, 'IMDSH-DEVICE-1')
    assert.equal(payload.reused, false)
    assert.match(payload.deviceToken, /^[A-Za-z0-9_-]{43}$/u)
    const deviceToken = payload.deviceToken
    // The client is told to keep the token in a cookie as well as in its own store.
    const setCookie = cookies(redeemed)[0] ?? ''
    assert.match(setCookie, new RegExp(`^webim_device=${deviceToken}`, 'u'))
    assert.match(setCookie, /HttpOnly/u)
    assert.match(setCookie, /Path=\//u)

    // The token is a full credential for the proxied app...
    const page = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: `webim_device=${deviceToken}` } })
    assert.equal(page.status, 200)
    assert.match(await page.text(), /hello-harness/u)
    assert.equal(upstream.state.requests.at(-1).headers.cookie, 'UPSTREAM_SESSION=abc')

    // ...and for the /__webim namespace too.
    const status = await fetch(`http://127.0.0.1:${port}/__webim/api/status`, {
      headers: { cookie: `webim_device=${deviceToken}` },
    })
    assert.equal(status.status, 200)
    assert.equal((await status.json()).auth.devicePairing.activeDevices, 1)

    // `?device=` exists for handshakes that cannot set a cookie, and the token
    // is peeled off before the request is proxied.
    const viaQuery = await fetch(`http://127.0.0.1:${port}/?device=${deviceToken}`)
    assert.equal(viaQuery.status, 200)
    assert.equal(upstream.state.requests.at(-1).url, '/', 'the token must not reach upstream')
    const upgrade = await rawUpgrade(port, `/api/remote.mux?device=${deviceToken}`, '')
    assert.match(upgrade, /^HTTP\/1\.1 101/u)
    assert.equal(upstream.state.upgrades.at(-1).url, '/api/remote.mux')

    // A wrong token is still a closed door, and a device token never leaks out.
    const wrong = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: `webim_device=${createDeviceToken()}` } })
    assert.equal(wrong.status, 401)
    const refusedUpgrade = await rawUpgrade(port, '/api/remote.mux?device=nope', '')
    assert.match(refusedUpgrade, /^HTTP\/1\.1 401/u)
    const listed = await (await fetch(`http://127.0.0.1:${port}/__webim/pair/devices`, { headers: { cookie, 'user-agent': TEST_UA } })).json()
    assert.equal(JSON.stringify(listed).includes(deviceToken), false, 'the listing must never carry tokens')
    const device = listed.devices.find((entry) => entry.deviceId === 'IMDSH-DEVICE-1')
    assert.equal(device.name, 'iPhone 15 Pro')
    assert.equal(device.platform, 'ios')
    assert.equal(device.deviceIdPrefix, 'IMDSH-DE')
    assert.equal(device.revoked, false)
    assert.ok(device.lastSeenAt > 0, 'authenticated requests update the last-seen time')

    // Redeeming the same code from the same device returns the same token.
    const again = await (await post('/__webim/pair/redeem', { code, deviceId: 'IMDSH-DEVICE-1' })).json()
    assert.equal(again.ok, true)
    assert.equal(again.reused, true)
    assert.equal(again.deviceToken, deviceToken)

    // Another device on an already bound code is refused with a stable code.
    const stolen = await post('/__webim/pair/redeem', { code, deviceId: 'IMDSH-DEVICE-2' })
    assert.equal(stolen.status, 409)
    assert.equal((await stolen.json()).code, 'code-already-bound')

    // Revoking the device kills the token on the next request.
    const revoked = await post('/__webim/pair/revoke', { deviceId: 'IMDSH-DEVICE-1' }, { cookie })
    assert.equal(revoked.status, 200)
    assert.equal((await revoked.json()).device.revoked, true)
    const afterRevoke = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: `webim_device=${deviceToken}` } })
    assert.equal(afterRevoke.status, 401)
    const afterRevokeUpgrade = await rawUpgrade(port, `/api/remote.mux?device=${deviceToken}`, '')
    assert.match(afterRevokeUpgrade, /^HTTP\/1\.1 401/u)
  })

  it('accepts the deviceName alias the native client sends', async () => {
    const created = await (await post('/__webim/pair/code', {}, { cookie })).json()
    const redeemed = await post('/__webim/pair/redeem', {
      code: created.pairingCode.code,
      deviceId: 'IMDSH-UUID-ALIAS-1',
      deviceName: 'iPhone · iOS 18.2',
      platform: 'ios',
    })
    assert.equal(redeemed.status, 200)
    assert.equal((await redeemed.json()).device.name, 'iPhone · iOS 18.2')
  })

  it('answers unknown codes and malformed bodies with stable error codes', async () => {
    const unknown = await post('/__webim/pair/redeem', { code: 'AAAA-BBBB-CCCC', deviceId: 'device-x' })
    assert.equal(unknown.status, 401)
    assert.deepEqual({ ...(await unknown.json()) }, { ok: false, code: 'code-invalid', error: 'the pairing code is not valid' })

    const noDevice = await post('/__webim/pair/redeem', { code: 'AAAA-BBBB-CCCC' })
    assert.equal(noDevice.status, 400)
    assert.equal((await noDevice.json()).code, 'bad-request')

    const badBody = await fetch(`http://127.0.0.1:${port}/__webim/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    assert.equal(badBody.status, 400)

    const wrongMethod = await fetch(`http://127.0.0.1:${port}/__webim/pair/redeem`)
    assert.equal(wrongMethod.status, 405)

    const revokeNothing = await post('/__webim/pair/revoke', {}, { cookie })
    assert.equal(revokeNothing.status, 400)
    const revokeBoth = await post('/__webim/pair/revoke', { deviceId: 'a', code: 'AAAA-BBBB-CCCC' }, { cookie })
    assert.equal(revokeBoth.status, 400)

    // A cross-site POST from another origin cannot manage devices.
    const crossSite = await post('/__webim/pair/revoke', { deviceId: 'IMDSH-DEVICE-1' }, { cookie, origin: 'https://evil.example' })
    assert.equal(crossSite.status, 403)
  })

  it('rate limits anonymous redemption with the existing failure counter', async () => {
    const limiterStateDir = await mkdtemp(join(tmpdir(), 'webim-pairing-lock-'))
    const locked = createGateway({
      config: { host: '127.0.0.1', port: 0, password: '124', stateDir: limiterStateDir, maxFailures: 3, blockMinutes: 15 },
      upstreamOrigin: `http://127.0.0.1:${upstreamInfo.port}`,
      getCookie: async () => 'UPSTREAM_SESSION=abc',
      invalidateCookie: () => {},
      log: () => {},
    })
    const lockedPort = (await locked.listen()).port
    try {
      const attempt = async (code) => {
        const response = await fetch(`http://127.0.0.1:${lockedPort}/__webim/pair/redeem`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code, deviceId: 'device-1' }),
        })
        return { status: response.status, retryAfter: response.headers.get('retry-after'), payload: await response.json() }
      }
      const first = await attempt('AAAA-BBBB-CCCC')
      assert.equal(first.status, 401)
      assert.equal(first.payload.code, 'code-invalid')
      assert.equal((await attempt('AAAA-BBBB-CCCD')).status, 401)
      // The failure that crosses the threshold already answers 429.
      const third = await attempt('AAAA-BBBB-CCCE')
      assert.equal(third.status, 429)
      assert.ok(third.payload.retryAfterSeconds > 0)
      assert.ok(Number(third.retryAfter) > 0)
      // Even a valid code cannot be redeemed while the address is blocked.
      const minted = locked.pairingStore.createCode()
      const insideLock = await attempt(minted.code)
      assert.equal(insideLock.status, 429)
      assert.equal(insideLock.payload.code, 'rate-limited')
      assert.ok(insideLock.payload.retryAfterSeconds > 0)
    } finally {
      await locked.close()
      await rm(limiterStateDir, { recursive: true, force: true })
    }
  })

  it('does not spend the failure budget on a bound code or a revoked device', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'webim-pairing-budget-'))
    const budgeted = createGateway({
      config: { host: '127.0.0.1', port: 0, password: '124', stateDir: dir, maxFailures: 3, blockMinutes: 15 },
      upstreamOrigin: `http://127.0.0.1:${upstreamInfo.port}`,
      getCookie: async () => 'UPSTREAM_SESSION=abc',
      invalidateCookie: () => {},
      log: () => {},
    })
    const budgetPort = (await budgeted.listen()).port
    try {
      const attempt = async (code, deviceId) => {
        const response = await fetch(`http://127.0.0.1:${budgetPort}/__webim/pair/redeem`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code, deviceId }),
        })
        return { status: response.status, payload: await response.json() }
      }
      const record = budgeted.pairingStore.createCode()
      assert.equal((await attempt(record.code, 'device-1')).status, 200)
      // Four attempts from the wrong device would ban a guesser; here they must
      // stay a plain conflict, because the client clearly holds the code.
      for (let round = 0; round < 4; round += 1) {
        const wrong = await attempt(record.code, 'device-2')
        assert.equal(wrong.status, 409)
        assert.equal(wrong.payload.code, 'code-already-bound')
      }
      // Malformed requests are not guesses either.
      assert.equal((await attempt(record.code, 'not a device id')).status, 400)
      // A revoked device is refused, and still no ban.
      assert.equal(budgeted.pairingStore.revokeDevice({ deviceId: 'device-1' }).ok, true)
      const revoked = await attempt(record.code, 'device-1')
      assert.equal(revoked.status, 403)
      assert.equal(revoked.payload.code, 'device-revoked')
      assert.equal(revoked.payload.retryAfterSeconds, undefined)
    } finally {
      await budgeted.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
