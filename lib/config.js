import { homedir } from 'node:os'
import { isAbsolute, join, normalize, resolve } from 'node:path'

/** Defaults mirroring cordis.patch.yml. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  host: '0.0.0.0',
  port: 3081,
  // '' = password entry disabled: the token link / QR code is the only door.
  password: '',
  sessionDays: 30,
  // 'ua' = each session is pinned to the browser that created it (default);
  // 'off' = the old behaviour, where any client holding the cookie gets in.
  sessionBind: 'ua',
  cookieName: 'dsh_webim',
  maxFailures: 8,
  failureWindowMinutes: 10,
  blockMinutes: 15,
  // Empty array = every readable path the Harness process can reach.
  allowedRoots: [],
  // Extra denied path prefixes (case-insensitive on Windows).
  deniedPaths: [],
  linkifyPaths: true,
  logRequests: false,
  injectClient: true,
  // '' = $DSH_HOME/webim
  stateDir: '',
  // Extra authorities (host or host:port) accepted for same-origin checks.
  trustedProxies: [],
  // Optional IP/CIDR allow list; empty = any client that knows the password.
  allowIPs: [],
  // Advertised URL (shown in the status endpoint); '' = derived from the request.
  publicUrl: '',
  // Pinned remote-entry token. '' = generate once and persist in the state dir,
  // so the QR/link keeps working across restarts and can be refreshed from Settings.
  accessToken: '',
  // Cookie `Secure` flag. Turn on when a TLS terminator (nginx/Caddy) sits in front.
  secureCookies: false,
  // Optional feature switches. Unset keys keep their built-in default; Settings
  // can flip them at runtime (persisted in the state dir) without editing this file.
  features: {},
  // Explicit cloudflared path; '' = state dir copy, then PATH.
  tunnelBinary: '',
  // Allow downloading cloudflared on first use; off = bring your own binary.
  tunnelAutoInstall: true,
})

export function dshHome() {
  if (process.env.DSH_HOME && String(process.env.DSH_HOME).trim() !== '') return String(process.env.DSH_HOME)
  return join(homedir(), '.dsh')
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const text = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(text)) return true
  if (['0', 'false', 'no', 'off'].includes(text)) return false
  return fallback
}

function toInt(value, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const rounded = Math.trunc(n)
  if (rounded < min || rounded > max) return fallback
  return rounded
}

function toPathList(value) {
  if (value === undefined || value === null) return []
  const list = Array.isArray(value) ? value : [value]
  const out = []
  for (const item of list) {
    if (typeof item !== 'string' || item.trim() === '') continue
    const text = item.trim()
    out.push(isAbsolute(text) ? normalize(resolve(text)) : text)
  }
  return out
}

/**
 * Validate and normalize a Cordis patch config object.
 * Invalid values fall back to defaults instead of taking the profile down.
 * @param {object} raw
 * @returns {Readonly<object>}
 */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  // `password: ''` is meaningful: it turns the password entry off and leaves
  // the token link as the only way in.
  const password = typeof input.password === 'string' ? input.password : DEFAULTS.password
  const port = toInt(input.port, DEFAULTS.port, { min: 0, max: 65535 })
  const host = typeof input.host === 'string' && input.host.trim() !== '' ? input.host.trim() : DEFAULTS.host
  const sessionDays = toInt(input.sessionDays, DEFAULTS.sessionDays, { min: 1, max: 3650 })
  const sessionBind = input.sessionBind === 'off' ? 'off' : DEFAULTS.sessionBind
  const maxFailures = toInt(input.maxFailures, DEFAULTS.maxFailures, { min: 1, max: 1000 })
  const failureWindowMinutes = toInt(input.failureWindowMinutes, DEFAULTS.failureWindowMinutes, { min: 1, max: 24 * 60 })
  const blockMinutes = toInt(input.blockMinutes, DEFAULTS.blockMinutes, { min: 1, max: 30 * 24 * 60 })
  const cookieName = typeof input.cookieName === 'string' && /^[A-Za-z0-9_.-]+$/.test(input.cookieName)
    ? input.cookieName
    : DEFAULTS.cookieName
  const stateDirInput = typeof input.stateDir === 'string' ? input.stateDir.trim() : ''
  const stateDir = stateDirInput === '' ? join(dshHome(), 'webim') : resolve(stateDirInput)
  const publicUrl = typeof input.publicUrl === 'string' && input.publicUrl.trim() !== '' ? input.publicUrl.trim() : ''
  const accessToken = typeof input.accessToken === 'string' ? input.accessToken.trim() : ''
  const features = input.features && typeof input.features === 'object' ? Object.fromEntries(
    Object.entries(input.features).filter(([, value]) => typeof value === 'boolean'),
  ) : {}
  const tunnelBinary = typeof input.tunnelBinary === 'string' ? input.tunnelBinary.trim() : ''
  const tunnelAutoInstall = input.tunnelAutoInstall !== false

  return Object.freeze({
    ...DEFAULTS,
    enabled: toBool(input.enabled, DEFAULTS.enabled),
    host,
    port,
    password,
    passwordEnabled: password !== '',
    sessionDays,
    sessionBind,
    cookieName,
    maxFailures,
    failureWindowMinutes,
    blockMinutes,
    allowedRoots: Object.freeze(toPathList(input.allowedRoots)),
    deniedPaths: Object.freeze(toPathList(input.deniedPaths)),
    linkifyPaths: toBool(input.linkifyPaths, DEFAULTS.linkifyPaths),
    logRequests: toBool(input.logRequests, DEFAULTS.logRequests),
    injectClient: toBool(input.injectClient, DEFAULTS.injectClient),
    stateDir,
    trustedProxies: Object.freeze(Array.isArray(input.trustedProxies) ? input.trustedProxies.map(String) : []),
    allowIPs: Object.freeze(Array.isArray(input.allowIPs) ? input.allowIPs.map(String) : []),
    publicUrl,
    accessToken,
    secureCookies: toBool(input.secureCookies, DEFAULTS.secureCookies),
    features: Object.freeze(features),
    tunnelBinary,
    tunnelAutoInstall,
  })
}
