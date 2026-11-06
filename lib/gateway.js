import http from 'node:http'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { URL } from 'node:url'
import { normalizeConfig } from './config.js'
import { SessionStore, RateLimiter, safeEqual, passwordDigest } from './security.js'
import { createProxy } from './proxy.js'
import { handleFsRequest } from './files.js'
import { renderLogin, renderError, escapeHtml } from './pages.js'
import { TokenStore, tokenFromUrl, stripTokenParams } from './token.js'
import { PairingStore, DEVICE_COOKIE, deviceCookieHeader, publicCode } from './pairing.js'
import { VERSION, GATEWAY_NAME } from './version.js'

const ASSET_FILES = {
  '/__webim/client.js': { file: '../assets/client.js', type: 'text/javascript; charset=utf-8' },
  '/__webim/client.css': { file: '../assets/client.css', type: 'text/css; charset=utf-8' },
}

const HTML_SECURITY_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
  'x-frame-options': 'DENY',
}

function sendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, { ...HTML_SECURITY_HEADERS, ...extraHeaders })
  res.end(html)
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  })
  res.end(body)
}

/** Normalized client address; optionally honors X-Forwarded-For from trusted proxies. */
export function clientIp(req, config) {
  const raw = req.socket?.remoteAddress || ''
  const normalized = raw.startsWith('::ffff:') ? raw.slice(7) : raw
  const trusted = config.trustedProxies
  if (trusted.includes('*') || trusted.includes(normalized)) {
    const forwarded = req.headers['x-forwarded-for']
    if (typeof forwarded === 'string' && forwarded.trim() !== '') return forwarded.split(',')[0].trim()
  }
  return normalized
}

function ipAllowed(ip, config) {
  if (config.allowIPs.length === 0) return true
  const candidates = [ip, ip.startsWith('::ffff:') ? ip.slice(7) : ip]
  for (const rule of config.allowIPs) {
    if (rule === '*') return true
    if (candidates.includes(rule)) return true
    if (rule.endsWith('*') && candidates.some((candidate) => candidate.startsWith(rule.slice(0, -1)))) return true
  }
  return false
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function parseForm(body) {
  const params = new URLSearchParams(body.toString('utf8'))
  return {
    password: params.get('password') ?? '',
    next: params.get('next') ?? '/',
  }
}

/** Parse a JSON request body; returns undefined when it is not a JSON object. */
function parseJsonBody(body) {
  if (!body || body.length === 0) return {}
  try {
    const parsed = JSON.parse(body.toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** One cookie value out of a `Cookie` header, or '' when it is not there. */
function cookieValue(header, name) {
  if (typeof header !== 'string' || header === '') return ''
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() !== name) continue
    let value = segment.slice(at + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    return value
  }
  return ''
}

/** HTTP status for each stable pairing error code. */
const PAIRING_STATUS = {
  'bad-request': 400,
  'code-invalid': 401,
  'code-expired': 410,
  'code-already-bound': 409,
  'device-revoked': 403,
  'unknown-device': 404,
  'unknown-code': 404,
}

/**
 * Which rejected redemptions count as a failed guess. Only the ones a stranger
 * can reach by trying codes: a client that merely presents the wrong deviceId
 * for a code it legitimately holds must not lock its own address out.
 */
const PAIRING_GUESS_ERRORS = new Set(['code-invalid', 'code-expired'])

/** Only allow in-site redirect targets. */
export function sanitizeNext(value) {
  if (typeof value !== 'string' || value === '') return '/'
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/'
  if (value.includes('\r') || value.includes('\n')) return '/'
  return value
}

function sameOrigin(req) {
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  const source = req.headers.origin || req.headers.referer
  if (!source) return true
  try {
    return new URL(source).host === host
  } catch {
    return false
  }
}

/**
 * The remote-entry HTTP server.
 * @param {object} options
 * @param {object} options.config raw or normalized config
 * @param {string} options.upstreamOrigin local Harness origin, e.g. http://127.0.0.1:50912
 * @param {() => Promise<string>} options.getCookie
 * @param {() => void} options.invalidateCookie
 * @param {TokenStore} [options.tokenStore] shared token store (plugin mode)
 * @param {PairingStore} [options.pairingStore] shared device pairing store
 * @param {(line: string) => void} [options.log]
 */
export function createGateway({
  config: rawConfig,
  upstreamOrigin,
  getCookie,
  invalidateCookie,
  tokenStore,
  pairingStore,
  features,
  log = () => {},
}) {
  const config = Object.freeze({ ...normalizeConfig(rawConfig) })
  /** `password: ''` turns the password door off; the token link is then the only entry. */
  const passwordEnabled = config.password !== ''
  const tokens = tokenStore ?? new TokenStore({
    stateDir: config.stateDir,
    configuredToken: config.accessToken,
    log,
  })
  /** Long-lived device pairing; only touched when a device token shows up. */
  const pairing = pairingStore ?? new PairingStore({
    stateDir: config.stateDir,
    pairDays: config.pairDays,
    log,
  })
  /** Runtime feature switches; a missing provider means "everything on". */
  const featureState = () => {
    if (typeof features === 'function') {
      try {
        return features() ?? {}
      } catch {
        return {}
      }
    }
    return features && typeof features === 'object' ? features : {}
  }
  const featureOn = (key) => featureState()[key] !== false
  // Sessions embed the current token, so a refreshed token also signs out
  // every browser that entered through the old link.
  const session = new SessionStore(config, undefined, { salt: () => tokens.current() })
  const limiter = new RateLimiter(config)
  const proxy = createProxy({
    origin: upstreamOrigin,
    getCookie,
    invalidateCookie,
    log,
    injectClient: config.injectClient,
    mobileUi: () => featureOn('mobileUi'),
  })

  const startedAt = Date.now()
  /** Stable, non-reversible id for the token this instance serves. */
  const tokenId = () => createHash('sha256').update(tokens.current()).digest('hex').slice(0, 10)
  const stats = { requests: 0, proxied: 0, logins: 0, rejected: 0, wsActive: 0, wsTotal: 0 }
  const assetCache = new Map()
  /** Client sockets that were upgraded; server.close() would otherwise wait for them. */
  const upgradedSockets = new Set()

  async function loadAsset(pathname) {
    const entry = ASSET_FILES[pathname]
    if (!entry) return undefined
    const fileUrl = new URL(entry.file, import.meta.url)
    // Re-read when the file changes: the plugin can be reinstalled while this
    // gateway keeps running, and a stale cached bundle would silently hide it.
    const info = await stat(fileUrl)
    const cached = assetCache.get(pathname)
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached
    const content = await readFile(fileUrl)
    const asset = { body: content, type: entry.type, mtimeMs: info.mtimeMs, size: info.size }
    assetCache.set(pathname, asset)
    return asset
  }

  /** User-Agent of this request, used to pin sessions to one browser. */
  function agentOf(req) {
    const raw = req.headers['user-agent']
    return typeof raw === 'string' ? raw : ''
  }

  /**
   * Device token carried by this request: the cookie first, then the `?device=`
   * value the route peeled off the URL. The query parameter exists because a
   * WebSocket handshake opened from a browser cannot carry a custom header, and
   * because it keeps a native client simple.
   */
  function deviceTokenOf(req, url, deviceParam = '') {
    const fromCookie = cookieValue(req.headers.cookie, DEVICE_COOKIE)
    if (fromCookie !== '') return fromCookie
    if (typeof deviceParam === 'string' && deviceParam !== '') return deviceParam
    if (url && typeof url.searchParams?.get === 'function') return url.searchParams.get('device') ?? ''
    return ''
  }

  /**
   * Which credential opened this request: `'session'` for the browser cookie
   * minted by the token link or the password, `'device'` for a paired device,
   * `''` for none. Both doors are equally trusted downstream — a paired device
   * only ever reaches the same proxy the browser does.
   */
  function authenticate(req, url, deviceParam = '') {
    if (session.readFromCookieHeader(req.headers.cookie, Date.now(), agentOf(req)) !== null) return 'session'
    if (pairing.authenticateDevice(deviceTokenOf(req, url, deviceParam)) !== null) return 'device'
    return ''
  }

  function isAuthenticated(req, url, deviceParam = '') {
    return authenticate(req, url, deviceParam) !== ''
  }

  function currentAuthority(req) {
    return typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : `127.0.0.1:${config.port}`
  }

  function isSecureRequest(req) {
    if (config.secureCookies) return true
    if (req.socket && req.socket.encrypted) return true
    // A TLS terminator in front (nginx, Caddy, cloudflared) marks the hop.
    const forwarded = req.headers['x-forwarded-proto']
    if (typeof forwarded === 'string' && forwarded.split(',')[0].trim().toLowerCase() === 'https') return true
    return false
  }

  async function serveAsset(req, res, pathname) {
    const asset = await loadAsset(pathname)
    if (!asset) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    res.writeHead(200, {
      'content-type': asset.type,
      // These two files are tiny and change with the plugin, so they must never
      // be pinned by a stale browser cache (the URL only varies by version).
      'cache-control': 'no-cache, must-revalidate',
      'x-content-type-options': 'nosniff',
    })
    if (req.method === 'HEAD') res.end()
    else res.end(asset.body)
  }

  function loginPage(req, res, { error = '', retryAfterSeconds = 0, status = 200, next = '/' } = {}) {
    const html = renderLogin({
      error,
      retryAfterSeconds,
      next: sanitizeNext(next),
      passwordForm: passwordEnabled,
    })
    sendHtml(res, status, html, retryAfterSeconds > 0 ? { 'retry-after': String(retryAfterSeconds) } : {})
  }

  async function handleLogin(req, res, url) {
    const ip = clientIp(req, config)
    const next = sanitizeNext(url.searchParams.get('next') ?? '/')

    if (!passwordEnabled) {
      stats.rejected += 1
      // Drain any posted body before answering, otherwise a keep-alive client
      // desynchronises the parser and the next request on that socket gets a
      // bare 400 from Node itself.
      req.resume()
      loginPage(req, res, {
        status: req.method === 'GET' || req.method === 'HEAD' ? 401 : 403,
        next,
        error: req.method === 'GET' || req.method === 'HEAD' ? '' : '口令入口已关闭，请使用带令牌的链接或二维码进入。',
      })
      return
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (isAuthenticated(req)) {
        res.writeHead(303, { location: next, 'cache-control': 'no-store' })
        res.end()
        return
      }
      loginPage(req, res, { next })
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST' })
      res.end()
      return
    }

    const state = limiter.check(ip)
    if (!state.allowed) {
      stats.rejected += 1
      loginPage(req, res, {
        status: 429,
        retryAfterSeconds: state.retryAfterSeconds,
        next,
        error: '失败的尝试过多，入口已临时锁定。',
      })
      return
    }

    const contentType = String(req.headers['content-type'] || '')
    if (!contentType.includes('application/x-www-form-urlencoded')) {
      sendJson(res, 415, { ok: false, error: 'expected application/x-www-form-urlencoded' })
      return
    }

    let body
    try {
      body = await readBody(req)
    } catch (error) {
      sendJson(res, 413, { ok: false, error: error instanceof Error ? error.message : 'bad body' })
      return
    }
    const form = parseForm(body)
    if (safeEqual(form.password, config.password)) {
      limiter.success(ip)
      stats.logins += 1
      const token = session.issue(Date.now(), agentOf(req))
      log(`login ok from ${ip}`)
      res.writeHead(303, {
        location: sanitizeNext(form.next),
        'cache-control': 'no-store',
        'set-cookie': session.cookieHeader(token, { secure: isSecureRequest(req) }),
      })
      res.end()
      return
    }

    const after = limiter.fail(ip)
    stats.rejected += 1
    log(`login failed from ${ip} (failures=${after.failures}, blocked=${!after.allowed})`)
    loginPage(req, res, {
      status: after.allowed ? 401 : 429,
      retryAfterSeconds: after.allowed ? 0 : after.retryAfterSeconds,
      next,
      error: '口令不正确。',
    })
  }

  async function handleLogout(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'POST only' }, { allow: 'POST' })
      return
    }
    if (!sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
      return
    }
    res.writeHead(303, {
      location: '/__webim/login',
      'cache-control': 'no-store',
      'set-cookie': session.clearCookieHeader({ secure: isSecureRequest(req) }),
    })
    res.end()
  }

  // --- device pairing -------------------------------------------------------

  /** Guard the authenticated POSTs against cross-site requests. */
  function rejectCrossOrigin(req, res) {
    if (sameOrigin(req)) return false
    sendJson(res, 403, { ok: false, code: 'cross-origin', error: 'cross-origin request rejected' })
    return true
  }

  /** Read and parse the small JSON body these endpoints expect. */
  async function readJsonRequest(req, res, limit = 8 * 1024) {
    let body
    try {
      body = await readBody(req, limit)
    } catch (error) {
      sendJson(res, 413, { ok: false, code: 'bad-request', error: error instanceof Error ? error.message : 'bad body' })
      return undefined
    }
    const payload = parseJsonBody(body)
    if (payload === undefined) {
      sendJson(res, 400, { ok: false, code: 'bad-request', error: 'expected a JSON object body' })
      return undefined
    }
    return payload
  }

  /**
   * POST /__webim/pair/redeem — the only endpoint a native client calls while
   * it is still anonymous. Failed attempts count against the same per-IP
   * limiter the password door uses, so guessing codes costs the same ban.
   */
  async function handlePairRedeem(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'method-not-allowed', error: 'POST only' }, { allow: 'POST' })
      return
    }
    const ip = clientIp(req, config)
    const state = limiter.check(ip)
    if (!state.allowed) {
      stats.rejected += 1
      sendJson(res, 429, {
        ok: false,
        code: 'rate-limited',
        error: 'too many failed attempts, try again later',
        retryAfterSeconds: state.retryAfterSeconds,
      }, { 'retry-after': String(state.retryAfterSeconds) })
      return
    }
    const payload = await readJsonRequest(req, res)
    if (!payload) return
    // `name` is the documented field; `deviceName` is honoured too because the
    // IMDSH client shipped with it first and accepting both costs nothing.
    const displayName = typeof payload.name === 'string' && payload.name !== ''
      ? payload.name
      : typeof payload.deviceName === 'string' ? payload.deviceName : ''
    const result = pairing.redeem({
      code: typeof payload.code === 'string' ? payload.code : '',
      deviceId: typeof payload.deviceId === 'string' ? payload.deviceId : '',
      name: displayName,
      platform: typeof payload.platform === 'string' ? payload.platform : '',
    })
    if (!result.ok) {
      const counted = PAIRING_GUESS_ERRORS.has(result.code)
      const after = counted ? limiter.fail(ip) : limiter.check(ip)
      stats.rejected += 1
      if (counted) log(`device pairing rejected from ${ip} (${result.code})`)
      else log(`device pairing refused from ${ip} (${result.code})`)
      const status = after.allowed ? PAIRING_STATUS[result.code] ?? 400 : 429
      const body = { ok: false, code: result.code, error: result.message }
      const headers = {}
      if (!after.allowed) {
        body.retryAfterSeconds = after.retryAfterSeconds
        headers['retry-after'] = String(after.retryAfterSeconds)
      }
      sendJson(res, status, body, headers)
      return
    }
    limiter.success(ip)
    stats.logins += 1
    log(`device paired: ${result.device.deviceIdPrefix} from ${ip}${result.reused ? ' (same device, token reused)' : ''}`)
    sendJson(res, 200, {
      ok: true,
      deviceId: result.device.deviceId,
      deviceToken: result.deviceToken,
      reused: result.reused,
      device: result.device,
    }, { 'set-cookie': deviceCookieHeader(result.deviceToken, { secure: isSecureRequest(req) }) })
  }

  /** POST /__webim/pair/code — mint a pairing code. */
  async function handlePairCode(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'method-not-allowed', error: 'POST only' }, { allow: 'POST' })
      return
    }
    if (rejectCrossOrigin(req, res)) return
    const payload = await readJsonRequest(req, res, 4 * 1024)
    if (!payload) return
    let days
    if (payload.days !== undefined) {
      const requested = Number(payload.days)
      if (!Number.isFinite(requested) || requested < 0 || requested > 3650) {
        sendJson(res, 400, { ok: false, code: 'bad-request', error: 'days must be an integer between 0 and 3650' })
        return
      }
      days = Math.trunc(requested)
    }
    const record = pairing.createCode({ days })
    log(`pairing code created (${record.expiresAt === 0 ? 'never expires' : `expires ${new Date(record.expiresAt).toISOString()}`})`)
    sendJson(res, 200, { ok: true, pairDays: pairing.pairDays, pairingCode: publicCode(record) })
  }

  /** GET /__webim/pair/devices — the owner's inventory. */
  async function handlePairDevices(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, code: 'method-not-allowed', error: 'GET only' }, { allow: 'GET, HEAD' })
      return
    }
    sendJson(res, 200, {
      ok: true,
      pairDays: pairing.pairDays,
      devices: pairing.listDevices(),
      pairingCodes: pairing.listCodes(),
    })
  }

  /** POST /__webim/pair/revoke — revoke one device or one unused code. */
  async function handlePairRevoke(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'method-not-allowed', error: 'POST only' }, { allow: 'POST' })
      return
    }
    if (rejectCrossOrigin(req, res)) return
    const payload = await readJsonRequest(req, res, 4 * 1024)
    if (!payload) return
    const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId : ''
    const code = typeof payload.code === 'string' ? payload.code : ''
    if ((deviceId === '') === (code === '')) {
      sendJson(res, 400, { ok: false, code: 'bad-request', error: 'send either deviceId or code, not both' })
      return
    }
    const result = deviceId !== '' ? pairing.revokeDevice({ deviceId }) : pairing.revokeCode({ code })
    if (!result.ok) {
      sendJson(res, PAIRING_STATUS[result.code] ?? 400, { ok: false, code: result.code, error: result.message })
      return
    }
    if (result.device) log(`device revoked: ${result.device.deviceIdPrefix}`)
    else log('pairing code revoked')
    sendJson(res, 200, { ok: true, device: result.device ?? null, pairingCode: result.code ?? null })
  }

  async function handleStatus(req, res) {
    const ip = clientIp(req, config)
    sendJson(res, 200, {
      ok: true,
      name: GATEWAY_NAME,
      version: VERSION,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      upstream: upstreamOrigin,
      authority: currentAuthority(req),
      listener: { host: config.host, port: config.port },
      auth: {
        mode: passwordEnabled ? 'password+token' : 'token-only',
        passwordEnabled,
        sessionDays: config.sessionDays,
        passwordLength: passwordEnabled ? config.password.length : 0,
        weakPassword: passwordEnabled && config.password.length < 8,
        insecureTransport: !isSecureRequest(req),
        blocked: limiter.snapshot(),
        devicePairing: pairing.info(),
      },
      accessToken: tokens.info(),
      features: featureState(),
      files: {
        enabled: featureOn('fileBrowser'),
        linkifyPaths: featureOn('linkifyPaths'),
        allowedRoots: config.allowedRoots,
        deniedPaths: config.deniedPaths,
      },
      stats: { ...stats, clientIp: ip },
      platform: process.platform,
      node: process.version,
    })
  }

  async function route(req, res) {
    stats.requests += 1
    const ip = clientIp(req, config)
    if (!ipAllowed(ip, config)) {
      stats.rejected += 1
      sendJson(res, 403, { ok: false, error: 'client address not allowed' })
      return
    }

    let url
    try {
      url = new URL(req.url, `http://${req.headers.host || 'gateway.invalid'}`)
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad request target' })
      return
    }
    // A device token may arrive as `?device=`. Peel it off the URL before
    // anything downstream looks at the request, so the credential cannot end up
    // in the upstream's request log; the gate keeps its own copy.
    const deviceParam = url.searchParams.get('device') ?? ''
    if (deviceParam !== '') {
      url.searchParams.delete('device')
      const rest = url.searchParams.toString()
      req.url = `${url.pathname}${rest === '' ? '' : `?${rest}`}${url.hash}`
    }
    const pathname = url.pathname

    // Token entry: a link carrying ?token=<token> mints the normal browser
    // session, so a phone only has to scan the QR code. The token is stripped
    // from the address bar before the app loads, and an already-logged-in
    // browser that opens an old link is simply redirected to the clean URL.
    const tokenParam = tokenFromUrl(req.url)
    if (tokenParam !== '' && (req.method === 'GET' || req.method === 'HEAD')) {
      const cleanTarget = sanitizeNext(stripTokenParams(`${url.pathname}${url.search}`))
      if (isAuthenticated(req)) {
        res.writeHead(303, {
          location: cleanTarget,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        })
        res.end()
        return
      }
      if (tokens.matches(tokenParam)) {
        stats.logins += 1
        log(`token login from ${ip}`)
        res.writeHead(303, {
          location: cleanTarget,
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'set-cookie': session.cookieHeader(session.issue(Date.now(), agentOf(req)), { secure: isSecureRequest(req) }),
        })
        res.end()
        return
      }
      stats.rejected += 1
      loginPage(req, res, {
        status: 401,
        next: cleanTarget,
        error: passwordEnabled
          ? '这个进入链接已失效（令牌可能已被刷新）。请输入口令，或回到设置页重新扫码/复制最新链接。'
          : '这个进入链接已失效（令牌可能已被刷新）。请回到 DSH 的「设置 → 远程接入」重新扫码或复制最新链接。',
      })
      return
    }

    if (pathname === '/__webim/ping') {
      sendJson(res, 200, {
        ok: true,
        name: GATEWAY_NAME,
        version: VERSION,
        // Which generation is answering. Two gateway instances can share a port
        // on Windows (SO_REUSEADDR), and this is the only way to tell them apart.
        instance: { startedAt, tokenId: tokenId() },
      })
      return
    }
    if (pathname === '/__webim/login') {
      await handleLogin(req, res, url)
      return
    }
    if (pathname === '/__webim/logout') {
      await handleLogout(req, res)
      return
    }
    // Device pairing redemption is the one door that must work before the
    // caller has any credential at all; it is rate limited like the password.
    if (pathname === '/__webim/pair/redeem') {
      await handlePairRedeem(req, res)
      return
    }

    // The PWA manifest is fetched without credentials by the browser, so it
    // cannot go through the cookie gate. It is public metadata only.
    if (pathname === '/manifest.webmanifest' && (req.method === 'GET' || req.method === 'HEAD')) {
      stats.proxied += 1
      proxy.proxyHttp(req, res)
      return
    }

    const authenticated = isAuthenticated(req, url, deviceParam)
    if (!authenticated) {
      stats.rejected += 1
      const wantsJson = pathname.startsWith('/__webim/api/') || pathname.startsWith('/api/') || pathname === '/api'
        // The pairing endpoints are a JSON API for native clients: never answer
        // them with the login page, which a client cannot use.
        || pathname.startsWith('/__webim/pair/')
      if (wantsJson) {
        sendJson(res, 401, { ok: false, error: 'login required' })
        return
      }
      loginPage(req, res, { next: url.pathname + url.search, status: 401 })
      return
    }

    if (pathname in ASSET_FILES) {
      await serveAsset(req, res, pathname)
      return
    }
    if (pathname === '/__webim/api/status') {
      await handleStatus(req, res)
      return
    }
    if (pathname === '/__webim/pair/code') {
      await handlePairCode(req, res)
      return
    }
    if (pathname === '/__webim/pair/devices') {
      await handlePairDevices(req, res)
      return
    }
    if (pathname === '/__webim/pair/revoke') {
      await handlePairRevoke(req, res)
      return
    }
    if (pathname === '/__webim/fs') {
      if (!featureOn('fileBrowser')) {
        sendJson(res, 403, { ok: false, error: 'file access is turned off in Settings → 远程接入' })
        return
      }
      await handleFsRequest(req, res, { config, log })
      return
    }
    if (pathname.startsWith('/__webim/')) {
      sendJson(res, 404, { ok: false, error: 'unknown dsh-webim endpoint' })
      return
    }

    if (config.logRequests) log(`${req.method} ${pathname} from ${ip}${url.search}`)
    stats.proxied += 1
    proxy.proxyHttp(req, res)
  }

  const server = http.createServer((req, res) => {
    res.setHeader('x-dsh-webim', GATEWAY_NAME)
    route(req, res).catch((error) => {
      log(`route error: ${error instanceof Error ? error.stack || error.message : String(error)}`)
      if (!res.headersSent) {
        sendHtml(res, 500, renderError({ title: '网关内部错误', message: 'dsh-webim 处理请求失败。', status: 500 }))
      } else {
        res.destroy()
      }
    })
  })
  server.headersTimeout = 65_000
  server.requestTimeout = 0
  server.keepAliveTimeout = 65_000

  server.on('upgrade', (req, socket, head) => {
    const ip = clientIp(req, config)
    // A WebSocket handshake cannot carry a custom header from a browser, so a
    // paired device may pass its token as `?device=` here as well as in a cookie.
    let upgradeUrl
    let upgradeDevice = ''
    try {
      upgradeUrl = new URL(req.url ?? '/', `http://${req.headers.host || 'gateway.invalid'}`)
      upgradeDevice = upgradeUrl.searchParams.get('device') ?? ''
      if (upgradeDevice !== '') {
        upgradeUrl.searchParams.delete('device')
        const rest = upgradeUrl.searchParams.toString()
        req.url = `${upgradeUrl.pathname}${rest === '' ? '' : `?${rest}`}`
      }
    } catch {
      upgradeUrl = undefined
    }
    if (!ipAllowed(ip, config) || !isAuthenticated(req, upgradeUrl, upgradeDevice)) {
      log(`rejected upgrade from ${ip}`)
      try {
        socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
      } catch {
        // client already gone
      }
      return
    }
    stats.wsActive += 1
    stats.wsTotal += 1
    upgradedSockets.add(socket)
    socket.on('close', () => {
      upgradedSockets.delete(socket)
      stats.wsActive = Math.max(0, stats.wsActive - 1)
    })
    proxy.forwardUpgrade(req, socket, head)
  })

  return {
    config,
    server,
    stats,
    upstreamOrigin,
    tokenStore: tokens,
    pairingStore: pairing,
    blockedClients: () => limiter.snapshot(),
    authority: proxy.authority,
    async listen() {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(config.port, config.host)
      })
      const address = server.address()
      return typeof address === 'object' && address ? address : { address: config.host, port: config.port }
    },
    close() {
      limiter.dispose()
      proxy.dispose()
      for (const socket of upgradedSockets) {
        try {
          socket.destroy()
        } catch {
          // already gone
        }
      }
      upgradedSockets.clear()
      return new Promise((resolve) => {
        if (!server.listening) {
          resolve()
          return
        }
        const forceTimer = setTimeout(() => resolve(), 3000)
        forceTimer.unref?.()
        server.close(() => {
          clearTimeout(forceTimer)
          resolve()
        })
        server.closeAllConnections?.()
      })
    },
  }
}
