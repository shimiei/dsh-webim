import { networkInterfaces } from 'node:os'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Non-internal IPv4 addresses of this host, stable order (private ranges first). */
export function lanAddresses() {
  const out = []
  for (const [iface, groups] of Object.entries(networkInterfaces())) {
    for (const entry of groups ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      out.push({ iface, address: entry.address })
    }
  }
  const rank = (address) => (address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : address.startsWith('172.') ? 2 : 3)
  return out.sort((a, b) => rank(a.address) - rank(b.address) || a.address.localeCompare(b.address))
}

/** Normalize a user supplied public base URL, or '' when it is not http(s). */
export function normalizePublicUrl(raw) {
  if (typeof raw !== 'string') return ''
  const text = raw.trim()
  if (text === '') return ''
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
  return parsed.origin + parsed.pathname.replace(/\/+$/u, '')
}

/** Append a query parameter to a base URL that may already carry a query. */
export function withToken(base, token) {
  if (base === '' || token === '') return base
  try {
    const parsed = new URL(base)
    parsed.searchParams.set('token', token)
    return parsed.toString()
  } catch {
    return base
  }
}

/**
 * Every way to reach the gateway, ordered for display, with a token-bearing URL
 * for the QR code. A live tunnel URL wins (it is the only address that works
 * from outside the LAN), then the persisted public address, then the LAN.
 * Loopback is off by default: the owner is already inside the app. `includeLan`
 * is false when the owner switched the LAN entry off, so a host that is bound to
 * 127.0.0.1 never advertises addresses nobody can reach.
 * @param {{port:number, publicUrl?:string, tunnelUrl?:string, token?:string, includeLoopback?:boolean, includeLan?:boolean}} options
 * @returns {{id:string, label:string, url:string, tokenUrl:string, kind:string}[]}
 */
export function accessUrls({ port, publicUrl = '', tunnelUrl = '', token = '', includeLoopback = false, includeLan = true } = {}) {
  const urls = []
  const seen = new Set()
  const push = (id, label, url, kind) => {
    const base = url.replace(/\/+$/u, '')
    if (base === '' || seen.has(base)) return
    seen.add(base)
    urls.push({ id, label, url: `${base}/`, tokenUrl: withToken(`${base}/`, token), kind })
  }
  if (tunnelUrl !== '') push('tunnel', 'Cloudflare 隧道', tunnelUrl, 'tunnel')
  if (publicUrl !== '') push('public', '公网地址', publicUrl, 'public')
  if (includeLan) {
    for (const { iface, address } of lanAddresses()) push(`lan:${address}`, `局域网 · ${iface}`, `http://${address}:${port}`, 'lan')
  }
  if (includeLoopback) push('local', '本机', `http://127.0.0.1:${port}`, 'local')
  return urls
}

/**
 * The persisted "which entry should the QR code encode" choice.
 *
 * Stored as the entry id (`lan:192.168.1.7`, `public`, `tunnel`) because the
 * addresses themselves change between runs. An id that no longer exists simply
 * falls back to the first entry, so a dead tunnel never leaves a blank QR.
 */
export class QrTargetStore {
  constructor({ stateDir, log = () => {} }) {
    this.dir = stateDir
    this.file = join(stateDir, 'qr-target.txt')
    this.log = log
    this.value = ''
    this.loaded = false
    this.load()
  }

  load() {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!existsSync(this.file)) return
      const saved = readFileSync(this.file, 'utf8').trim()
      if (/^[a-z0-9:._-]{1,64}$/iu.test(saved)) this.value = saved
    } catch (error) {
      this.log(`qr-target.txt unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Requested target id, or '' when the owner never picked one. */
  current() {
    return this.value
  }

  /**
   * Remember the choice. '' clears it, so the first entry is used again.
   * @param {string} raw entry id from the settings page
   * @returns {string} the stored id
   */
  set(raw) {
    const normalized = typeof raw === 'string' ? raw.trim() : ''
    if (normalized !== '' && !/^[a-z0-9:._-]{1,64}$/iu.test(normalized)) {
      throw new Error('that is not a known entry id')
    }
    try {
      if (normalized === '') {
        this.value = ''
        if (existsSync(this.file)) unlinkSync(this.file)
        return ''
      }
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      writeFileSync(this.file, `${normalized}\n`, { encoding: 'utf8', mode: 0o600 })
      this.value = normalized
    } catch (error) {
      throw new Error(`could not save the QR target: ${error instanceof Error ? error.message : String(error)}`)
    }
    return normalized
  }
}

/** Pick the entry a QR code should encode: the stored id, else the first entry. */
export function resolveQrTarget(urls, wantedId) {
  if (!Array.isArray(urls) || urls.length === 0) return null
  if (typeof wantedId === 'string' && wantedId !== '') {
    const match = urls.find((entry) => entry.id === wantedId)
    if (match) return match
  }
  return urls[0]
}

/**
 * The persisted "what public address should the QR code use" override.
 * Kept in the gateway state directory so it needs no profile edit.
 */
export class PublicUrlStore {
  constructor({ stateDir, initial = '', log = () => {} }) {
    this.dir = stateDir
    this.file = join(stateDir, 'public-url.txt')
    this.log = log
    this.value = normalizePublicUrl(initial)
    this.loaded = false
    this.load()
  }

  load() {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!existsSync(this.file)) return
      const saved = normalizePublicUrl(readFileSync(this.file, 'utf8'))
      if (saved !== '') this.value = saved
    } catch (error) {
      this.log(`public-url.txt unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Current override, or the configured default when no override exists. */
  current() {
    return this.value
  }

  /** Save a new override; an empty value clears it. Returns the effective value. */
  set(raw) {
    const normalized = normalizePublicUrl(raw)
    try {
      if (normalized === '') {
        this.value = ''
        if (existsSync(this.file)) unlinkSync(this.file)
        return ''
      }
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      writeFileSync(this.file, `${normalized}\n`, { encoding: 'utf8', mode: 0o600 })
      this.value = normalized
    } catch (error) {
      throw new Error(`could not save the public address: ${error instanceof Error ? error.message : String(error)}`)
    }
    return normalized
  }
}
