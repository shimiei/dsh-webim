import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { safeEqual } from './security.js'

const TOKEN_BYTES = 32
const FILE_VERSION = 1

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** One freshly minted access token: 32 random bytes in URL-safe base64 (43 chars). */
export function createToken() {
  return b64url(randomBytes(TOKEN_BYTES))
}

/** True when a candidate has the shape of a token this module issues. */
export function looksLikeToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{20,120}$/u.test(value)
}

/**
 * Persisted remote-entry token.
 *
 * The token is the "something you have" half of the remote entry: visiting
 * `http://host:port/?token=<token>` mints the normal browser session, so a
 * phone can scan one QR code instead of typing a password. It is rotatable
 * (refresh) and survives restarts in the gateway state directory.
 *
 * A non-empty `configuredToken` from the Cordis config wins over the file and
 * disables rotation, which is what pinned deployments want.
 */
export class TokenStore {
  /**
   * @param {object} options
   * @param {string} options.stateDir gateway state directory
   * @param {string} [options.configuredToken] pinned token from config
   * @param {(message: string) => void} [options.log] diagnostic sink
   */
  constructor({ stateDir, configuredToken = '', log = () => {} }) {
    this.stateDir = stateDir
    this.log = log
    this.pinned = typeof configuredToken === 'string' && configuredToken.trim() !== '' ? configuredToken.trim() : ''
    this.file = join(stateDir, 'token.json')
    this.token = ''
    this.createdAt = 0
    this.rotatedAt = 0
    this.load()
  }

  get configured() {
    return this.pinned !== ''
  }

  /** Current token value. */
  current() {
    return this.token
  }

  /** Constant-time token check; empty candidates never match. */
  matches(candidate) {
    if (typeof candidate !== 'string' || candidate === '') return false
    if (!looksLikeToken(candidate)) return false
    return safeEqual(candidate, this.token)
  }

  /** @returns {{enabled:boolean, configured:boolean, createdAt:number, rotatedAt:number, length:number}} */
  info() {
    return {
      enabled: this.token !== '',
      configured: this.configured,
      createdAt: this.createdAt,
      rotatedAt: this.rotatedAt,
      length: this.token.length,
    }
  }

  load() {
    this.lastError = ''
    if (this.pinned) {
      this.token = this.pinned
      this.createdAt = 0
      this.rotatedAt = 0
      return
    }
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'))
        if (raw && raw.version === FILE_VERSION && looksLikeToken(raw.token)) {
          this.token = raw.token
          this.createdAt = Number(raw.createdAt) || 0
          this.rotatedAt = Number(raw.rotatedAt) || this.createdAt
          return
        }
        this.lastError = 'token.json has an unexpected shape'
      }
      // A missing file is simply the first boot, not an error worth reporting.
    } catch (error) {
      this.lastError = `token.json unreadable: ${error instanceof Error ? error.message : String(error)}`
    }
    this.log(this.lastError)
    this.token = createToken()
    this.createdAt = Date.now()
    this.rotatedAt = this.createdAt
    this.persist()
  }

  /** Replace the token with a fresh one; the previous URL stops working at once. */
  rotate(now = Date.now()) {
    if (this.pinned) {
      throw new Error('the access token is pinned by the plugin config (accessToken); clear it to rotate')
    }
    this.token = createToken()
    this.rotatedAt = now
    this.createdAt = this.createdAt || now
    this.persist()
    return this.token
  }

  persist() {
    try {
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
      const temp = `${this.file}.tmp`
      writeFileSync(
        temp,
        `${JSON.stringify({
          version: FILE_VERSION,
          token: this.token,
          createdAt: this.createdAt,
          rotatedAt: this.rotatedAt,
        }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
      renameSync(temp, this.file)
      try {
        chmodSync(this.file, 0o600)
      } catch {
        // Windows: mode is advisory
      }
    } catch (error) {
      this.log(`could not persist token: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Extract a token from a request URL: `?token=` wins, `?t=` is the short alias. */
export function tokenFromUrl(url) {
  if (typeof url !== 'string' || url === '') return ''
  try {
    const parsed = new URL(url, 'http://placeholder')
    return parsed.searchParams.get('token') || parsed.searchParams.get('t') || ''
  } catch {
    return ''
  }
}

/** Strip the token parameters so the visible URL stays clean. */
export function stripTokenParams(url) {
  if (typeof url !== 'string' || url === '') return '/'
  try {
    const parsed = new URL(url, 'http://placeholder')
    parsed.searchParams.delete('token')
    parsed.searchParams.delete('t')
    const search = parsed.searchParams.toString()
    return `${parsed.pathname}${search === '' ? '' : `?${search}`}${parsed.hash}`
  } catch {
    return '/'
  }
}
