import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { SessionStore, RateLimiter, safeEqual, passwordDigest } from '../lib/security.js'
import { normalizeConfig } from '../lib/config.js'

const config = normalizeConfig({ password: '124', stateDir: 'C:\\temp\\dsh-webim-test-state', sessionDays: 30 })

test('safeEqual compares arbitrary strings without leaking length', () => {
  assert.equal(safeEqual('124', '124'), true)
  assert.equal(safeEqual('124', '125'), false)
  assert.equal(safeEqual('124', '1240'), false)
  assert.equal(safeEqual('', ''), true)
})

test('session tokens round-trip and carry the password digest', () => {
  const secret = Buffer.alloc(32, 7)
  const store = new SessionStore(config, secret)
  const token = store.issue(1000)
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  assert.equal(payload.v, 1)
  // No salt provider: the digest is the plain password digest.
  assert.equal(payload.pw, passwordDigest('124'))
  assert.deepEqual(store.verify(token, 2000), { iat: 1000, exp: 1000 + 30 * 86400000 })
})

test('rotating the access token revokes sessions minted through the old link', () => {
  const secret = Buffer.alloc(32, 7)
  let current = 'token-a'
  const store = new SessionStore(config, secret, { salt: () => current })
  const token = store.issue(1000)
  assert.equal(store.verify(token, 2000)?.iat, 1000)
  current = 'token-b'
  assert.equal(store.verify(token, 2000), null)
  const fresh = store.issue(3000)
  assert.equal(store.verify(fresh, 4000)?.iat, 3000)
})

test('tampered or expired sessions are rejected', () => {
  const store = new SessionStore(config, Buffer.alloc(32, 7))
  const token = store.issue(1000)
  const parts = token.split('.')
  const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}xx`
  assert.equal(store.verify(tampered, 2000), null)
  assert.equal(store.verify(`${parts[0]}.${parts[1]}.`, 2000), null)
  assert.equal(store.verify('garbage', 2000), null)
  const late = 1000 + 31 * 86400000
  assert.equal(store.verify(token, late), null)
})

test('rotating the password revokes outstanding sessions', () => {
  const secret = Buffer.from('0123456789abcdef0123456789abcdef')
  const store = new SessionStore(config, secret)
  const token = store.issue()
  assert.ok(store.verify(token))
  const rotated = normalizeConfig({ ...config, password: '124-new' })
  const nextStore = new SessionStore(rotated, secret)
  assert.equal(nextStore.verify(token), null)
})

test('cookie header parsing finds the session among other cookies', () => {
  const store = new SessionStore(config, Buffer.alloc(32, 7))
  const token = store.issue()
  assert.ok(store.readFromCookieHeader(`a=1; ${store.cookieName}=${token}; b=2`))
  assert.equal(store.readFromCookieHeader('a=1; b=2'), null)
  assert.match(store.cookieHeader(token), /HttpOnly/u)
  assert.match(store.cookieHeader(token), /SameSite=Lax/u)
  assert.match(store.clearCookieHeader(), /Max-Age=0/u)
})

test('rate limiter blocks after the configured number of failures', () => {
  const limiter = new RateLimiter(normalizeConfig({ maxFailures: 3, blockMinutes: 15, failureWindowMinutes: 10, stateDir: 'x' }))
  const ip = '203.0.113.9'
  assert.equal(limiter.check(ip).allowed, true)
  limiter.fail(ip)
  limiter.fail(ip)
  assert.equal(limiter.check(ip).allowed, true)
  const after = limiter.fail(ip)
  assert.equal(after.allowed, false)
  assert.ok(after.retryAfterSeconds > 0)
  const snapshot = limiter.snapshot()
  assert.equal(snapshot[0].ip, ip)
  limiter.success(ip)
  assert.equal(limiter.check(ip).allowed, true)
  limiter.dispose()
})

test('config normalization keeps good values and falls back for bad ones', () => {
  const normalized = normalizeConfig({
    password: 'secret-124',
    port: '3081',
    sessionDays: 0,
    maxFailures: -4,
    allowedRoots: ['C:\\data', 'D:/other', ''],
    insecureValue: null,
  })
  assert.equal(normalized.port, 3081)
  assert.equal(normalized.password, 'secret-124')
  assert.equal(normalized.sessionDays, 30)
  assert.equal(normalized.maxFailures, 8)
  assert.equal(normalized.allowedRoots.length, 2)
  assert.equal(normalized.enabled, true)
})

test('session cookie digest is stable', () => {
  assert.equal(passwordDigest('124'), createHash('sha256').update('124').digest('hex'))
})
test('sessions are pinned to the browser that created them', () => {
  const store = new SessionStore(config, Buffer.alloc(32, 7))
  const phone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1'
  const laptop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0'
  const cookie = store.issue(Date.now(), phone)
  assert.ok(store.verify(cookie, Date.now(), phone), 'the same browser keeps its session')
  assert.equal(store.verify(cookie, Date.now(), laptop), null, 'a copied cookie is worthless elsewhere')
  assert.equal(store.verify(cookie, Date.now(), ''), null, 'a request without a UA cannot replay it')
  assert.ok(store.readFromCookieHeader(`${store.cookieName}=${cookie}`, Date.now(), phone))
  assert.equal(store.readFromCookieHeader(`${store.cookieName}=${cookie}`, Date.now(), laptop), null)
})

test('sessionBind: off restores the unpinned behaviour', () => {
  const loose = new SessionStore(normalizeConfig({ ...config, sessionBind: 'off' }), Buffer.alloc(32, 7))
  const cookie = loose.issue(Date.now(), 'first-browser')
  assert.ok(loose.verify(cookie, Date.now(), 'another-browser'))
})