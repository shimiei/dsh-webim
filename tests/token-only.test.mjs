import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { gzipSync, gunzipSync } from 'node:zlib'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGateway } from '../lib/gateway.js'

const TOKEN = 'fixed-token-for-tests-0123456789abcdefg'
const SCRIPT = 'console.log("compressed asset")\n'

function createUpstream() {
  const state = { hits: [] }
  const server = http.createServer((req, res) => {
    state.hits.push(req.url)
    if (req.url === '/asset.js') {
      const body = gzipSync(Buffer.from(SCRIPT, 'utf8'))
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-encoding': 'gzip',
        'content-length': String(body.length),
      })
      res.end(body)
      return
    }
    if (req.url === '/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json' })
      res.end('{"name":"Harness","short_name":"Harness"}')
      return
    }
    if (req.url === '/') {
      // Even when the gateway asks for identity, an upstream may still compress.
      const body = gzipSync(Buffer.from('<!doctype html><html><head><title>h</title></head><body>hello-harness</body></html>', 'utf8'))
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-encoding': 'gzip',
        'content-length': String(body.length),
      })
      res.end(body)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('nope')
  })
  return { server, state }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address())))
}

/** Raw HTTP so the test sees the exact bytes and headers the browser gets. */
function rawRequest(port, { method = 'GET', path = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end(body === '' ? undefined : body)
  })
}

describe('dsh-webim token-only mode and compressed pass-through', () => {
  let upstream
  let gateway
  let port
  let stateDir
  let cookie

  before(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'webim-token-only-'))
    upstream = createUpstream()
    const upstreamInfo = await listen(upstream.server)
    gateway = createGateway({
      config: {
        host: '127.0.0.1',
        port: 0,
        password: '',
        accessToken: TOKEN,
        stateDir,
      },
      upstreamOrigin: `http://127.0.0.1:${upstreamInfo.port}`,
      getCookie: async () => 'UPSTREAM_SESSION=abc',
      invalidateCookie: () => {},
      log: () => {},
    })
    port = (await gateway.listen()).port
    const entry = await rawRequest(port, { path: `/?token=${TOKEN}` })
    assert.equal(entry.status, 303)
    cookie = String(entry.headers['set-cookie']).split(';')[0]
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

  it('shows a token-only notice without a password form', async () => {
    const response = await rawRequest(port, { path: '/' })
    assert.equal(response.status, 401)
    const html = response.body.toString('utf8')
    assert.doesNotMatch(html, /<form/u)
    assert.doesNotMatch(html, /name="password"/u)
    assert.match(html, /令牌/u)
  })

  it('refuses password logins once the password door is off', async () => {
    const body = new URLSearchParams({ password: '124', next: '/' }).toString()
    const response = await rawRequest(port, {
      method: 'POST',
      path: '/__webim/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    assert.equal(response.status, 403)
    assert.match(response.body.toString('utf8'), /口令入口已关闭/u)
  })

  it('reports token-only auth in the status endpoint', async () => {
    const response = await rawRequest(port, { path: '/__webim/api/status', headers: { cookie } })
    assert.equal(response.status, 200)
    const payload = JSON.parse(response.body.toString('utf8'))
    assert.equal(payload.auth.mode, 'token-only')
    assert.equal(payload.auth.passwordEnabled, false)
    assert.equal(payload.auth.passwordLength, 0)
    assert.equal(payload.auth.weakPassword, false)
    assert.equal(JSON.stringify(payload.accessToken).includes(TOKEN), false)
  })

  it('serves the PWA manifest without credentials', async () => {
    const response = await rawRequest(port, { path: '/manifest.webmanifest' })
    assert.equal(response.status, 200)
    assert.match(response.body.toString('utf8'), /Harness/u)
  })

  it('keeps content-encoding on compressed assets so the browser can decode them', async () => {
    const response = await rawRequest(port, { path: '/asset.js', headers: { cookie, 'accept-encoding': 'gzip' } })
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-encoding'], 'gzip')
    assert.equal(gunzipSync(response.body).toString('utf8'), SCRIPT)
  })

  it('re-encodes the injected document as plain utf-8 html', async () => {
    const response = await rawRequest(port, { path: '/', headers: { cookie } })
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-encoding'], undefined)
    const html = response.body.toString('utf8')
    assert.match(html, /hello-harness/u)
    assert.match(html, /\/__webim\/client\.js\?v=/u)
  })
})
