import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomInt } from 'node:crypto'
import { safeEqual } from './security.js'

const DAY_MS = 24 * 60 * 60 * 1000
const DEVICE_TOKEN_BYTES = 32
const FILE_VERSION = 1
/** `lastSeenAt` is bookkeeping only, so it is flushed at most this often. */
const LAST_SEEN_PERSIST_MS = 60 * 1000
/** One year: the device cookie is a convenience copy, the App stores the token. */
const DEVICE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60

/**
 * Code alphabet. Visually ambiguous characters are left out on purpose: no
 * `0/O`, no `1/I/L`, no `U`, and none of `B/G/S/Z` because they read like
 * `8/6/5/2`. What remains is unambiguous in every monospace font.
 */
const CODE_ALPHABET = '23456789ACDEFHJKMNPQRTVWXY'
const CODE_GROUPS = 3
const CODE_GROUP_SIZE = 4
export const CODE_LENGTH = CODE_GROUPS * CODE_GROUP_SIZE
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`, 'u')
/** The cookie a native client may carry instead of the browser session. */
export const DEVICE_COOKIE = 'webim_device'
/** Longest deviceId accepted from a client (a UUID is well below this). */
const DEVICE_ID_MAX = 128
const DEVICE_NAME_MAX = 64
const DEVICE_PLATFORM_MAX = 32
/** Ids are opaque client strings, never secrets; keep them boring on purpose. */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/u

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** One long-lived device token: 32 random bytes in URL-safe base64 (43 chars). */
export function createDeviceToken() {
  return b64url(randomBytes(DEVICE_TOKEN_BYTES))
}

/** True when a candidate has the shape of a device token this module issues. */
export function looksLikeDeviceToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{20,120}$/u.test(value)
}

/** One fresh pairing code in canonical form, e.g. `K7RM-2QXP-9HDA`. */
export function createPairingCode() {
  const chars = []
  for (let index = 0; index < CODE_LENGTH; index += 1) chars.push(CODE_ALPHABET[randomInt(CODE_ALPHABET.length)])
  return formatPairCode(chars.join(''))
}

/** Group a bare code into the `XXXX-XXXX-XXXX` shape the UI shows. */
export function formatPairCode(raw) {
  const text = typeof raw === 'string' ? raw : ''
  const groups = []
  for (let index = 0; index < text.length; index += CODE_GROUP_SIZE) groups.push(text.slice(index, index + CODE_GROUP_SIZE))
  return groups.join('-')
}

/**
 * Fold user input into the canonical code: upper case, separators dropped.
 * `abcd efgh jkmn` and `ABCD-EFGH-JKMN` are the same code.
 */
export function normalizePairCode(raw) {
  if (typeof raw !== 'string') return ''
  return raw.toUpperCase().replace(/[^0-9A-Z]/gu, '')
}

/** True when the input is a well-shaped pairing code (in any typing style). */
export function looksLikePairCode(value) {
  const normalized = normalizePairCode(value)
  return normalized !== '' && CODE_PATTERN.test(normalized)
}

/** Device ids are echoed back to their owner, so only keep the safe shape. */
export function normalizeDeviceId(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  return DEVICE_ID_PATTERN.test(text) ? text : ''
}

function normalizeLabel(raw, limit) {
  const text = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/gu, '').trim() : ''
  return text.slice(0, limit)
}

/** Short prefix used in the settings list and in the log. */
export function deviceIdPrefix(deviceId) {
  const text = typeof deviceId === 'string' ? deviceId : ''
  return text.slice(0, 8)
}

/**
 * Public, token-free view of one paired device.
 * Never add the token here: this object is what leaves the process.
 */
export function publicDevice(device) {
  return {
    deviceId: device.deviceId,
    deviceIdPrefix: deviceIdPrefix(device.deviceId),
    name: device.name,
    platform: device.platform,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    revoked: device.revokedAt > 0,
    revokedAt: device.revokedAt,
  }
}

/**
 * Public view of one pairing code. `expiresAt: 0` means it never expires.
 * Never add the device token here.
 */
export function publicCode(record, now = Date.now()) {
  const expired = record.expiresAt > 0 && record.expiresAt <= now
  return {
    code: record.code,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    expiresInDays: record.expiresAt === 0 ? 0 : Math.max(0, Math.ceil((record.expiresAt - now) / DAY_MS)),
    permanent: record.expiresAt === 0,
    expired,
    redeemed: record.deviceId !== '',
    deviceIdPrefix: deviceIdPrefix(record.deviceId),
    revoked: record.revokedAt > 0,
    revokedAt: record.revokedAt,
  }
}

/** The `Set-Cookie` value for a freshly redeemed device token. */
export function deviceCookieHeader(token, { secure = false } = {}) {
  const attrs = [
    `${DEVICE_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${DEVICE_COOKIE_MAX_AGE_SECONDS}`,
    `Expires=${new Date(Date.now() + DEVICE_COOKIE_MAX_AGE_SECONDS * 1000).toUTCString()}`,
  ]
  if (secure) attrs.push('Secure')
  return attrs.join('; ')
}

function fail(code, message) {
  return { ok: false, code, message }
}

function asNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

function sanitizeCode(raw) {
  if (!raw || typeof raw !== 'object') return null
  const code = normalizePairCode(typeof raw.code === 'string' ? raw.code : '')
  if (!looksLikePairCode(code)) return null
  return {
    code: formatPairCode(code),
    createdAt: asNumber(raw.createdAt),
    expiresAt: asNumber(raw.expiresAt),
    deviceId: normalizeDeviceId(raw.deviceId),
    redeemedAt: asNumber(raw.redeemedAt),
    revokedAt: asNumber(raw.revokedAt),
  }
}

function sanitizeDevice(raw) {
  if (!raw || typeof raw !== 'object') return null
  const deviceId = normalizeDeviceId(raw.deviceId)
  if (deviceId === '') return null
  const token = typeof raw.token === 'string' && looksLikeDeviceToken(raw.token) ? raw.token : ''
  const revokedAt = asNumber(raw.revokedAt)
  if (token === '' && revokedAt === 0) return null
  return {
    deviceId,
    name: normalizeLabel(raw.name, DEVICE_NAME_MAX),
    platform: normalizeLabel(raw.platform, DEVICE_PLATFORM_MAX),
    token,
    createdAt: asNumber(raw.createdAt),
    lastSeenAt: asNumber(raw.lastSeenAt),
    revokedAt,
  }
}

/**
 * Long-lived device pairing.
 *
 * One pairing code is minted in Settings, typed into the native client once,
 * and redeemed exactly once: the redemption binds the code to the client's
 * `deviceId` and hands out a long-lived device token. The same `deviceId` that
 * redeems the same code again (reinstall, restore from backup) gets the very
 * same token back, so nothing has to be re-paired; a *different* `deviceId`
 * using an already bound code is refused.
 *
 * State lives in `pairing.json` in the gateway state directory, written the
 * same way as `token.json` (0600, temp file + rename). A corrupt file degrades
 * to an empty table instead of taking the entry down: every device then simply
 * has to pair again.
 */
export class PairingStore {
  /**
   * @param {object} options
   * @param {string} options.stateDir gateway state directory
   * @param {number} [options.pairDays] default code lifetime; 0 = never expires
   * @param {(message: string) => void} [options.log] diagnostic sink
   */
  constructor({ stateDir, pairDays = 30, log = () => {} }) {
    this.dir = stateDir
    this.file = join(stateDir, 'pairing.json')
    this.log = log
    this.pairDays = Number.isFinite(Number(pairDays)) && Number(pairDays) >= 0 ? Math.trunc(Number(pairDays)) : 30
    /** @type {Array<object>} */
    this.codes = []
    /** @type {Array<object>} */
    this.devices = []
    this.lastError = ''
    this.persistedAt = 0
    this.load()
  }

  load() {
    this.lastError = ''
    this.codes = []
    this.devices = []
    try {
      if (!existsSync(this.file)) return
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!raw || typeof raw !== 'object' || raw.version !== FILE_VERSION) {
        throw new Error('pairing.json has an unexpected shape')
      }
      const codes = Array.isArray(raw.codes) ? raw.codes.map(sanitizeCode).filter(Boolean) : []
      const devices = Array.isArray(raw.devices) ? raw.devices.map(sanitizeDevice).filter(Boolean) : []
      this.codes = codes
      this.devices = devices
    } catch (error) {
      // A damaged table must never stop the remote entry: degrade to "nothing
      // is paired" and say so in the log, then let the next write rebuild it.
      this.lastError = `pairing.json unreadable, starting with an empty pairing table: ${error instanceof Error ? error.message : String(error)}`
      this.log(this.lastError)
      this.codes = []
      this.devices = []
    }
  }

  /** Counters for the settings page and for diagnostics. */
  info(now = Date.now()) {
    const active = this.devices.filter((device) => device.revokedAt === 0).length
    const live = this.codes.filter((record) => record.revokedAt === 0 && (record.expiresAt === 0 || record.expiresAt > now)).length
    return { pairDays: this.pairDays, devices: this.devices.length, activeDevices: active, codes: this.codes.length, activeCodes: live }
  }

  /**
   * Mint a pairing code.
   * @param {{days?: number, now?: number}} [options] `days: 0` = never expires
   * @returns {object} the stored record
   */
  createCode({ days, now = Date.now() } = {}) {
    const span = Number.isFinite(Number(days)) && Number(days) >= 0 ? Math.trunc(Number(days)) : this.pairDays
    const record = {
      code: createPairingCode(),
      createdAt: now,
      // 0 = permanent, so an owner who never wants to re-pair can say so.
      expiresAt: span > 0 ? now + span * DAY_MS : 0,
      deviceId: '',
      redeemedAt: 0,
      revokedAt: 0,
    }
    this.codes.push(record)
    this.persist()
    return record
  }

  /**
   * Redeem a code for a device and hand out its token.
   *
   * The result is either `{ok: true, deviceToken, device, reused}` or
   * `{ok: false, code, message}` with a stable machine-readable `code`:
   * `bad-request`, `code-invalid`, `code-expired`, `code-already-bound`,
   * `device-revoked`.
   * @param {{code?: string, deviceId?: string, name?: string, platform?: string, now?: number}} request
   */
  redeem({ code, deviceId, name = '', platform = '', now = Date.now() } = {}) {
    const wantedCode = normalizePairCode(code)
    const wantedDevice = normalizeDeviceId(deviceId)
    if (wantedDevice === '') return fail('bad-request', 'deviceId is missing or malformed')
    if (!looksLikePairCode(wantedCode)) return fail('code-invalid', 'the pairing code is not valid')

    const record = this.findCode(wantedCode)
    if (!record || record.revokedAt > 0) return fail('code-invalid', 'the pairing code is not valid')
    if (record.expiresAt > 0 && record.expiresAt <= now) return fail('code-expired', 'the pairing code has expired')
    if (record.deviceId !== '' && record.deviceId !== wantedDevice) {
      return fail('code-already-bound', 'this pairing code is already bound to another device')
    }

    const existing = this.findDevice(wantedDevice)
    if (existing) {
      // A revoked device never comes back through the code it was paired with:
      // that would resurrect a stolen token. Only a code minted *after* the
      // revocation (which the owner had to authenticate for) may re-pair it.
      if (existing.revokedAt > 0) {
        if (record.deviceId === wantedDevice) return fail('device-revoked', 'this device has been revoked')
        existing.revokedAt = 0
        existing.token = createDeviceToken()
        existing.createdAt = now
        existing.lastSeenAt = now
        if (name !== '') existing.name = normalizeLabel(name, DEVICE_NAME_MAX)
        if (platform !== '') existing.platform = normalizeLabel(platform, DEVICE_PLATFORM_MAX)
        record.deviceId = wantedDevice
        record.redeemedAt = now
        this.persist()
        return { ok: true, deviceToken: existing.token, device: publicDevice(existing), reused: false }
      }
      record.deviceId = wantedDevice
      record.redeemedAt = record.redeemedAt || now
      existing.lastSeenAt = now
      if (name !== '') existing.name = normalizeLabel(name, DEVICE_NAME_MAX)
      if (platform !== '') existing.platform = normalizeLabel(platform, DEVICE_PLATFORM_MAX)
      this.persist()
      return { ok: true, deviceToken: existing.token, device: publicDevice(existing), reused: true }
    }

    const device = {
      deviceId: wantedDevice,
      name: normalizeLabel(name, DEVICE_NAME_MAX),
      platform: normalizeLabel(platform, DEVICE_PLATFORM_MAX),
      token: createDeviceToken(),
      createdAt: now,
      lastSeenAt: now,
      revokedAt: 0,
    }
    this.devices.push(device)
    record.deviceId = wantedDevice
    record.redeemedAt = now
    this.persist()
    return { ok: true, deviceToken: device.token, device: publicDevice(device), reused: false }
  }

  /**
   * Constant-time device token check for the auth gate.
   * Every live device is compared, so the answer time does not depend on the
   * position of the matching record.
   * @param {string} token candidate from the cookie or `?device=`
   * @param {number} [now]
   * @returns {object|null} the public device view, or null
   */
  authenticateDevice(token, now = Date.now()) {
    if (!looksLikeDeviceToken(token)) return null
    let match = null
    for (const device of this.devices) {
      if (device.revokedAt > 0 || device.token === '') continue
      if (safeEqual(token, device.token)) match = device
    }
    if (!match) return null
    this.touch(match, now)
    return publicDevice(match)
  }

  /** Record activity without writing the file on every single request. */
  touch(device, now = Date.now()) {
    if (now - (device.lastSeenAt || 0) < 1000) return
    device.lastSeenAt = now
    if (now - this.persistedAt >= LAST_SEEN_PERSIST_MS) this.persist()
  }

  /** Is this deviceId known and not revoked? */
  isDeviceActive(deviceId) {
    const device = this.findDevice(normalizeDeviceId(deviceId))
    return device !== null && device.revokedAt === 0
  }

  /**
   * Revoke one device: its token stops working on the next request.
   * @param {{deviceId?: string, now?: number}} request
   */
  revokeDevice({ deviceId, now = Date.now() } = {}) {
    const wanted = normalizeDeviceId(deviceId)
    if (wanted === '') return fail('bad-request', 'deviceId is missing or malformed')
    const device = this.findDevice(wanted)
    if (!device) return fail('unknown-device', 'no such paired device')
    if (device.revokedAt === 0) device.revokedAt = now
    // Wipe the secret as well: a copy of pairing.json taken later is useless.
    device.token = ''
    this.persist()
    return { ok: true, device: publicDevice(device) }
  }

  /**
   * Revoke one pairing code so it can no longer be redeemed. A device that was
   * already paired with it keeps working until it is revoked on its own.
   * @param {{code?: string, now?: number}} request
   */
  revokeCode({ code, now = Date.now() } = {}) {
    const wanted = normalizePairCode(code)
    if (!looksLikePairCode(wanted)) return fail('bad-request', 'the pairing code is not valid')
    const record = this.findCode(wanted)
    if (!record) return fail('unknown-code', 'no such pairing code')
    if (record.revokedAt === 0) record.revokedAt = now
    this.persist()
    return { ok: true, code: publicCode(record, now) }
  }

  /** Every paired device, newest first, without tokens. */
  listDevices() {
    return this.devices
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((device) => publicDevice(device))
  }

  /** Every pairing code, newest first, without tokens. */
  listCodes(now = Date.now()) {
    return this.codes
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((record) => publicCode(record, now))
  }

  findCode(normalized) {
    if (normalized === '') return null
    let match = null
    for (const record of this.codes) {
      if (safeEqual(normalized, normalizePairCode(record.code))) match = record
    }
    return match
  }

  findDevice(deviceId) {
    if (deviceId === '') return null
    return this.devices.find((device) => device.deviceId === deviceId) ?? null
  }

  /** Atomic write: temp file, then rename, with 0600 like token.json. */
  persist(now = Date.now()) {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      const temp = `${this.file}.tmp`
      writeFileSync(
        temp,
        `${JSON.stringify({
          version: FILE_VERSION,
          codes: this.codes,
          devices: this.devices,
        }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
      renameSync(temp, this.file)
      this.persistedAt = now
      try {
        chmodSync(this.file, 0o600)
      } catch {
        // Windows: mode is advisory
      }
    } catch (error) {
      this.log(`could not persist pairing.json: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
