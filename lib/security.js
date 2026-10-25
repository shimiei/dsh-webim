import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DAY_MS = 24 * 60 * 60 * 1000
const SECRET_BYTES = 32

/** Constant-time comparison of two arbitrary strings. */
export function safeEqual(actual, expected) {
  const a = createHash('sha256').update(String(actual), 'utf8').digest()
  const b = createHash('sha256').update(String(expected), 'utf8').digest()
  return timingSafeEqual(a, b)
}

export function passwordDigest(password) {
  return createHash('sha256').update(String(password), 'utf8').digest('hex')
}

/**
 * Short fingerprint of a User-Agent.
 *
 * Sessions are bound to it by default: a cookie copied to another browser or
 * device (or a link leaked together with its cookie jar) stops working, while a
 * phone that roams between Wi-Fi and cellular keeps its session because the UA
 * does not change.
 */
export function uaDigest(userAgent) {
  return createHash('sha256').update(String(userAgent ?? ''), 'utf8').digest('hex').slice(0, 16)
}

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function fromB64url(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) return undefined
  const padding = '='.repeat((4 - (text.length % 4)) % 4)
  return Buffer.from(text.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
}

/** Load or create the gateway's own cookie-signing secret. */
export function loadSecret(stateDir) {
  const dir = stateDir
  const file = join(dir, 'secret')
  try {
    if (existsSync(file)) {
      const existing = fromB64url(readFileSync(file, 'utf8').trim())
      if (existing && existing.length === SECRET_BYTES) return existing
    }
  } catch {
    // fall through to regenerate
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const created = randomBytes(SECRET_BYTES)
  writeFileSync(file, `${b64url(created)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows: mode is advisory
  }
  return created
}

/**
 * Signed, stateless browser session.
 *
 * The payload carries a digest of the password *and* of the current access
 * token, so rotating either one revokes every outstanding session without any
 * server-side state. Refreshing the token therefore kills the old links and the
 * sessions they created at the same time.
 */
export class SessionStore {
  /**
   * @param {object} config normalized config
   * @param {Buffer} [secret] injected in tests
   * @param {{salt?: () => string}} [options] extra revocation value (the token)
   */
  constructor(config, secret, { salt } = {}) {
    this.config = config
    this.secret = secret ?? loadSecret(config.stateDir)
    this.saltOf = typeof salt === 'function' ? salt : () => ''
    this.maxAgeMs = config.sessionDays * DAY_MS
    // `sessionBind: 'off'` keeps the old behaviour (any client holding the
    // cookie gets in); the default pins each session to its User-Agent.
    this.bound = config.sessionBind !== 'off'
  }

  /** Digest binding sessions to the current password + token generation. */
  get digest() {
    const salt = this.saltOf() ?? ''
    return passwordDigest(salt === '' ? this.config.password : `${this.config.password}\u0000${salt}`)
  }

  get cookieName() {
    return this.config.cookieName
  }

  sign(body) {
    return createHmac('sha256', this.secret).update(body).digest()
  }

  /** @returns {string} cookie value */
  issue(now = Date.now(), userAgent = '') {
    const payload = {
      v: 1,
      iat: now,
      exp: now + this.maxAgeMs,
      pw: this.digest,
    }
    if (this.bound) payload.ua = uaDigest(userAgent)
    const body = b64url(JSON.stringify(payload))
    return `v1.${body}.${b64url(this.sign(body))}`
  }

  /** @returns {{iat:number, exp:number}|null} */
  verify(value, now = Date.now(), userAgent = '') {
    if (typeof value !== 'string') return null
    const parts = value.split('.')
    if (parts.length !== 3 || parts[0] !== 'v1') return null
    const [, body, encodedSignature] = parts
    const actual = fromB64url(encodedSignature)
    if (!actual) return null
    const expected = this.sign(body)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
    let payload
    try {
      const raw = fromB64url(body)
      if (!raw) return null
      payload = JSON.parse(raw.toString('utf8'))
    } catch {
      return null
    }
    if (!payload || payload.v !== 1) return null
    if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') return null
    if (payload.exp <= now || payload.exp - payload.iat > this.maxAgeMs) return null
    if (typeof payload.pw !== 'string' || !safeEqual(payload.pw, this.digest)) return null
    if (this.bound) {
      if (typeof payload.ua !== 'string' || !safeEqual(payload.ua, uaDigest(userAgent))) return null
    }
    return { iat: payload.iat, exp: payload.exp }
  }

  /** Read and verify the session token out of a Cookie header. */
  readFromCookieHeader(headerValue, now = Date.now(), userAgent = '') {
    if (typeof headerValue !== 'string' || headerValue === '') return null
    const name = this.cookieName
    for (const segment of headerValue.split(';')) {
      const at = segment.indexOf('=')
      if (at === -1) continue
      if (segment.slice(0, at).trim() !== name) continue
      let value = segment.slice(at + 1).trim()
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
      return this.verify(value, now, userAgent)
    }
    return null
  }

  /** Build the Set-Cookie attribute string for a freshly issued token. */
  cookieHeader(value, { secure = false } = {}) {
    const attrs = [
      `${this.cookieName}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(this.maxAgeMs / 1000)}`,
      `Expires=${new Date(Date.now() + this.maxAgeMs).toUTCString()}`,
    ]
    if (secure) attrs.push('Secure')
    return attrs.join('; ')
  }

  clearCookieHeader({ secure = false } = {}) {
    const attrs = [
      `${this.cookieName}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=0',
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ]
    if (secure) attrs.push('Secure')
    return attrs.join('; ')
  }
}

/**
 * Fixed-window failure limiter keyed by client IP.
 * A successful login clears the key, so normal use never accumulates.
 */
export class RateLimiter {
  constructor(config) {
    this.maxFailures = config.maxFailures
    this.windowMs = config.failureWindowMinutes * 60 * 1000
    this.blockMs = config.blockMinutes * 60 * 1000
    /** @type {Map<string, {failures:number, windowStart:number, blockedUntil:number, total:number}>} */
    this.entries = new Map()
    this.timer = setInterval(() => this.cleanup(), Math.max(60_000, Math.floor(this.windowMs / 2)))
    this.timer.unref?.()
  }

  entry(ip) {
    let entry = this.entries.get(ip)
    if (!entry) {
      entry = { failures: 0, windowStart: Date.now(), blockedUntil: 0, total: 0 }
      this.entries.set(ip, entry)
    }
    return entry
  }

  /** @returns {{allowed:boolean, retryAfterSeconds:number, failures:number}} */
  check(ip) {
    const now = Date.now()
    const entry = this.entry(ip)
    if (entry.blockedUntil > now) {
      return { allowed: false, retryAfterSeconds: Math.ceil((entry.blockedUntil - now) / 1000), failures: entry.failures }
    }
    if (now - entry.windowStart > this.windowMs) {
      entry.failures = 0
      entry.windowStart = now
    }
    return { allowed: true, retryAfterSeconds: 0, failures: entry.failures }
  }

  /** Record a failed attempt and return the check state after it. */
  fail(ip) {
    const now = Date.now()
    const entry = this.entry(ip)
    if (now - entry.windowStart > this.windowMs) {
      entry.failures = 0
      entry.windowStart = now
    }
    entry.failures += 1
    entry.total += 1
    if (entry.failures >= this.maxFailures) {
      entry.blockedUntil = now + this.blockMs
      entry.failures = 0
      entry.windowStart = now
    }
    return this.check(ip)
  }

  success(ip) {
    const entry = this.entries.get(ip)
    if (entry) {
      entry.failures = 0
      entry.blockedUntil = 0
    }
  }

  /** Owner-facing snapshot: only blocked clients, so the list cannot grow unbounded. */
  snapshot(limit = 32) {
    const now = Date.now()
    const out = []
    for (const [ip, entry] of this.entries) {
      const blocked = entry.blockedUntil > now
      if (!blocked && entry.failures === 0) continue
      out.push({
        ip,
        failures: entry.failures,
        totalFailures: entry.total,
        blockedSeconds: blocked ? Math.ceil((entry.blockedUntil - now) / 1000) : 0,
      })
      if (out.length >= limit) break
    }
    return out
  }

  cleanup() {
    const now = Date.now()
    for (const [ip, entry] of this.entries) {
      if (entry.blockedUntil <= now && now - entry.windowStart > this.windowMs && entry.failures === 0) {
        this.entries.delete(ip)
      }
    }
  }

  dispose() {
    clearInterval(this.timer)
  }
}
