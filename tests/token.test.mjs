import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGateway } from '../lib/gateway.js'
import { TokenStore, createToken, looksLikeToken, stripTokenParams, tokenFromUrl } from '../lib/token.js'
import { PublicUrlStore, accessUrls, normalizePublicUrl, withToken } from '../lib/urls.js'

function createUpstream() {
  return http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><head><title>Harness</title></head><body>hello-harness</body></html>')
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address())))
}

function cookies(response) {
  return response.headers.getSetCookie?.() ?? []
}

describe('dsh-webim access token', () => {
  let stateDir
  let upstream
  let upstreamInfo
  let gateway
  let port

  before(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'webim-token-'))
    upstream = createUpstream()
    upstreamInfo = await listen(upstream)
    gateway = createGateway({
      config: {
        host: '127.0.0.1',
        port: 0,
        password: '124',
        stateDir,
        maxFailures: 100,
        allowedRoots: [],
      },
      upstreamOrigin: `http://127.0.0.1:${upstreamInfo.port}`,
      getCookie: async () => 'UPSTREAM_SESSION=abc',
      invalidateCookie: () => {},
      log: () => {},
    })
    const address = await gateway.listen()
    port = address.port
  })

  after(async () => {
    await gateway?.close()
    await new Promise((resolve) => {
      upstream.close(resolve)
      upstream.closeAllConnections?.()
    })
    await rm(stateDir, { recursive: true, force: true })
  })

  it('mints a persistent token on first use', async () => {
    const token = gateway.tokenStore.current()
    assert.ok(looksLikeToken(token))
    assert.equal(token.length, 43)
    const saved = JSON.parse(await readFile(join(stateDir, 'token.json'), 'utf8'))
    assert.equal(saved.token, token)
    assert.equal(saved.version, 1)
    assert.equal(gateway.tokenStore.matches(token), true)
    assert.equal(gateway.tokenStore.matches(''), false)
    assert.equal(gateway.tokenStore.matches('short'), false)
    assert.equal(gateway.tokenStore.matches(`${token}x`), false)
    // A second store in the same directory reuses the persisted token.
    const reloaded = new TokenStore({ stateDir })
    assert.equal(reloaded.current(), token)
  })

  it('rejects manual tokens that are not the current one', () => {
    const store = new TokenStore({ stateDir: join(stateDir, 'other') })
    assert.equal(store.matches(createToken()), false)
    assert.equal(store.matches('x'.repeat(43)), false)
  })

  it('records why a stored token was replaced instead of being reused', async () => {
    // First boot has no file yet, which is normal rather than an error.
    const fresh = new TokenStore({ stateDir: join(stateDir, 'missing') })
    assert.equal(fresh.lastError, '')
    const broken = join(stateDir, 'broken')
    await mkdir(broken, { recursive: true })
    await writeFile(join(broken, 'token.json'), '{"version":1,"token":"too-short"}', 'utf8')
    const replaced = new TokenStore({ stateDir: broken })
    assert.equal(replaced.lastError, 'token.json has an unexpected shape')
    assert.equal(replaced.current().length, 43)
    const reused = new TokenStore({ stateDir })
    assert.equal(reused.lastError, '')
  })

  it('enters with ?token= and strips the token from the address bar', async () => {
    const token = gateway.tokenStore.current()
    const response = await fetch(`http://127.0.0.1:${port}/?token=${token}`, { redirect: 'manual' })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('location'), '/')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    const setCookie = cookies(response)[0]?.split(';')[0] ?? ''
    assert.ok(setCookie.startsWith('dsh_webim='))
    assert.equal(token in {}, false)

    const page = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: setCookie }, redirect: 'manual' })
    assert.equal(page.status, 200)
    assert.match(await page.text(), /hello-harness/u)
  })

  it('accepts the short ?t= alias and keeps other query parameters', async () => {
    const token = gateway.tokenStore.current()
    const response = await fetch(`http://127.0.0.1:${port}/?t=${token}&a=1`, { redirect: 'manual' })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('location'), '/?a=1')
  })

  it('shows the password form when the token is stale', async () => {
    const stale = 'a'.repeat(43)
    const response = await fetch(`http://127.0.0.1:${port}/?token=${stale}`, { redirect: 'manual' })
    assert.equal(response.status, 401)
    const html = await response.text()
    assert.match(html, /action="\/__webim\/login"/u)
    assert.match(html, /失效/u)
    assert.equal(cookies(response).length, 0)
  })

  it('redirects an already signed-in browser to the clean URL', async () => {
    const token = gateway.tokenStore.current()
    const entered = await fetch(`http://127.0.0.1:${port}/?token=${token}`, { redirect: 'manual' })
    const cookie = cookies(entered)[0]?.split(';')[0] ?? ''
    const response = await fetch(`http://127.0.0.1:${port}/?token=${'b'.repeat(43)}`, {
      headers: { cookie },
      redirect: 'manual',
    })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('location'), '/')
    assert.equal(cookies(response).length, 0)
  })

  it('reports the token in status without leaking it to anonymous callers', async () => {
    const token = gateway.tokenStore.current()
    const anonymous = await fetch(`http://127.0.0.1:${port}/__webim/api/status`, { redirect: 'manual' })
    assert.equal(anonymous.status, 401)

    const entered = await fetch(`http://127.0.0.1:${port}/?token=${token}`, { redirect: 'manual' })
    const cookie = cookies(entered)[0]?.split(';')[0] ?? ''
    const status = await fetch(`http://127.0.0.1:${port}/__webim/api/status`, { headers: { cookie } })
    const payload = await status.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.auth.mode, 'password+token')
    assert.equal(payload.accessToken.enabled, true)
    assert.equal(payload.accessToken.configured, false)
    assert.equal(JSON.stringify(payload).includes(token), false)
  })

  it('rotating the token invalidates the old link at once', async () => {
    const previous = gateway.tokenStore.current()
    const next = gateway.tokenStore.rotate()
    assert.notEqual(next, previous)
    assert.equal(gateway.tokenStore.matches(previous), false)
    assert.equal(gateway.tokenStore.matches(next), true)

    const oldLink = await fetch(`http://127.0.0.1:${port}/?token=${previous}`, { redirect: 'manual' })
    assert.equal(oldLink.status, 401)
    const newLink = await fetch(`http://127.0.0.1:${port}/?token=${next}`, { redirect: 'manual' })
    assert.equal(newLink.status, 303)

    const reloaded = new TokenStore({ stateDir })
    assert.equal(reloaded.current(), next)
  })

  it('honors a pinned token from config and refuses to rotate it', () => {
    const pinned = createToken()
    const store = new TokenStore({ stateDir: join(stateDir, 'pinned'), configuredToken: pinned })
    assert.equal(store.current(), pinned)
    assert.equal(store.configured, true)
    assert.equal(store.matches(pinned), true)
    assert.throws(() => store.rotate(), /pinned/u)
  })
})

describe('token helpers', () => {
  it('extracts and strips token parameters', () => {
    assert.equal(tokenFromUrl('/?token=abc'), 'abc')
    assert.equal(tokenFromUrl('/?t=abc&x=1'), 'abc')
    assert.equal(tokenFromUrl('/'), '')
    assert.equal(tokenFromUrl('not a url %'), '')
    assert.equal(stripTokenParams('/?token=abc&x=1'), '/?x=1')
    assert.equal(stripTokenParams('/?token=abc'), '/')
    assert.equal(stripTokenParams('/?t=abc#frag'), '/#frag')
    assert.equal(stripTokenParams(''), '/')
  })

  it('normalizes public addresses and appends tokens safely', () => {
    assert.equal(normalizePublicUrl('http://1.2.3.4:3081/'), 'http://1.2.3.4:3081')
    assert.equal(normalizePublicUrl('https://dsh.example.com/base/'), 'https://dsh.example.com/base')
    assert.equal(normalizePublicUrl('ftp://x'), '')
    assert.equal(normalizePublicUrl('garbage'), '')
    assert.equal(withToken('http://1.2.3.4:3081/', 'tok'), 'http://1.2.3.4:3081/?token=tok')
    assert.equal(withToken('http://1.2.3.4:3081/#x', 'tok'), 'http://1.2.3.4:3081/?token=tok#x')
  })

  it('orders entry URLs tunnel, public, LAN, then loopback on request', () => {
    const urls = accessUrls({ port: 3081, publicUrl: 'https://dsh.example.com', token: 'tok', includeLoopback: true })
    assert.equal(urls[0].id, 'public')
    assert.equal(urls[0].tokenUrl, 'https://dsh.example.com/?token=tok')
    assert.equal(urls.at(-1).id, 'local')
    assert.ok(urls.some((entry) => entry.id.startsWith('lan:')))

    // Loopback is off by default now: the owner is already inside the app.
    const withoutPublic = accessUrls({ port: 3081, token: 'tok' })
    assert.ok(withoutPublic.every((entry) => entry.id !== 'local'))
    assert.ok(withoutPublic.every((entry) => entry.tokenUrl.includes('token=tok')))
    assert.ok(withoutPublic.every((entry) => entry.kind === 'lan' || entry.kind === 'public'))

    // A live quick tunnel outranks every other address and is not duplicated.
    const tunnelled = accessUrls({
      port: 3081,
      publicUrl: 'https://dsh.example.com',
      tunnelUrl: 'https://blue-lake-1234.trycloudflare.com/',
      token: 'tok',
    })
    assert.equal(tunnelled[0].id, 'tunnel')
    assert.equal(tunnelled[0].kind, 'tunnel')
    assert.equal(tunnelled[0].tokenUrl, 'https://blue-lake-1234.trycloudflare.com/?token=tok')
    assert.equal(tunnelled.filter((entry) => entry.id === 'tunnel').length, 1)
  })

  it('drops the LAN entries when LAN access is switched off', () => {
    // A loopback-only listener must not advertise addresses nobody can reach.
    const onlyPublic = accessUrls({
      port: 3081,
      publicUrl: 'https://dsh.example.com',
      token: 'tok',
      includeLan: false,
      includeLoopback: true,
    })
    assert.deepEqual(onlyPublic.map((entry) => entry.kind), ['public', 'local'])

    const nothing = accessUrls({ port: 3081, token: 'tok', includeLan: false })
    assert.deepEqual(nothing, [], 'no LAN and no public address leaves no entry at all')
  })

  it('persists and clears the public address override', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'webim-public-'))
    try {
      const store = new PublicUrlStore({ stateDir: dir, initial: 'http://old.example' })
      assert.equal(store.current(), 'http://old.example')
      assert.equal(store.set('https://new.example/'), 'https://new.example')
      assert.equal(store.current(), 'https://new.example')
      const reloaded = new PublicUrlStore({ stateDir: dir, initial: 'http://old.example' })
      assert.equal(reloaded.current(), 'https://new.example')
      assert.equal(reloaded.set('not a url'), '')
      assert.equal(reloaded.set(''), '')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
