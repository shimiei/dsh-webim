import http from 'node:http'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { URL } from 'node:url'
import { dshHome, normalizeConfig } from './config.js'
import { createGateway } from './gateway.js'
import { mintBrowserCookie, readBrowserSecret } from './credentials.js'
import { TokenStore } from './token.js'
import { PublicUrlStore, QrTargetStore, accessUrls, resolveQrTarget } from './urls.js'
import { FEATURE_DEFS, FeatureStore } from './features.js'
import { TunnelManager, accessHeaders, describeCheckFailure } from './tunnel.js'
import { VERSION } from './version.js'

export const name = 'webim'

/** The Cordis web carrier this plugin rides on; the connection service carries the RPC channel. */
export const inject = ['webServer', 'connection']

const COOKIE_CACHE_MS = 60 * 60 * 1000
/** Shared RPC channel owned by this plugin; the browser half calls it by name. */
const CHANNEL = '/webim'
/** The browser channel only carries small control payloads. */
const BODY_LIMIT_BYTES = 64 * 1024
/** Process-wide handle to the currently serving gateway (survives hot reload). */
const GATEWAY_REGISTRY = Symbol.for('dsh-webim.gateway.v1')

/**
 * dsh-webim — remote entry for the local Harness.
 *
 * The plugin runs inside the Harness host process. It opens a second listener
 * (default 0.0.0.0:3081) reached either with a rotatable access token
 * (`http://host:3081/?token=...`, also shown as a QR code in Settings) or with
 * the entry password, then reverse-proxies every request to the local web
 * carrier itself, so a remote browser gets the exact same frontend, RPC bridge
 * and WebSocket mux that the local UI uses. The only extra surface is the
 * `/__webim/*` namespace: login/logout/status and the remote-safe local file view.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig loader config from cordis.patch.yml
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return

  /**
   * The host logger only reaches the app's own console, which is invisible when
   * the window is packaged. Keep a small rolling file in the state dir as well so
   * "the tunnel did nothing" can be debugged without a debugger.
   */
  const logFile = join(config.stateDir, 'plugin.log')
  const log = (message) => {
    const line = `${new Date().toISOString()} ${message}`
    try {
      ctx.logger?.info?.(`[dsh-webim] ${message}`)
    } catch {
      // logging is best effort
    }
    try {
      if (existsSync(logFile) && statSync(logFile).size > 256 * 1024) writeFileSync(logFile, '')
      appendFileSync(logFile, `${line}\n`)
    } catch {
      // the state dir may be read-only
    }
  }

  let disposed = false
  let gateway
  let boundPort = config.port
  /** @type {NodeJS.Timeout|undefined} */
  let retryTimer
  /** Serializes listener rebinds so two quick switch flips cannot overlap. */
  let reachQueue = Promise.resolve()
  let cachedCookie = ''
  let cachedAt = 0
  /** @type {Promise<string>|undefined} */
  let pendingCookie

  const tokens = new TokenStore({ stateDir: config.stateDir, configuredToken: config.accessToken, log })
  const publicUrls = new PublicUrlStore({ stateDir: config.stateDir, initial: config.publicUrl, log })
  const qrTargets = new QrTargetStore({ stateDir: config.stateDir, log })
  const features = new FeatureStore({ stateDir: config.stateDir, defaults: config.features, log })
  const tunnel = new TunnelManager({
    stateDir: config.stateDir,
    port: () => boundPort,
    binary: config.tunnelBinary,
    autoInstall: config.tunnelAutoInstall,
    mode: config.tunnelMode,
    hostname: config.tunnelHostname,
    log,
  })

  const webServer = () => ctx.get('webServer')

  // --- feature gates --------------------------------------------------------
  // Three switches decide how much of the machine is reachable: the master
  // switch (`enabled`) removes the listener entirely, `lan` decides whether the
  // listener binds a routable address, `public` decides whether the tunnel and
  // the saved public address are used at all.

  /** Is the whole remote entry switched on? */
  const remoteOn = () => features.enabled('enabled')
  /** Should the listener be reachable from other machines on the LAN? */
  const lanOn = () => remoteOn() && features.enabled('lan')
  /** Is the saved public address part of the entry list? */
  const publicOn = () => remoteOn() && features.enabled('public')
  /**
   * Should cloudflared run right now? The tunnel is an entry of its own: it
   * works with the public address off, because a quick tunnel already gives a
   * reachable https URL and most owners never need both.
   */
  const tunnelOn = () => remoteOn() && features.enabled('tunnel')

  /** Bind address: loopback when the LAN entry is off. */
  function bindHost() {
    return lanOn() ? config.host : '127.0.0.1'
  }

  /** Root URL of the local web carrier, once it has actually bound a port. */
  const localOrigin = () => {
    const server = webServer()
    if (!server) throw new Error('webServer service is unavailable')
    const origin = server.getOrigin()
    return String(origin).replace(/\/+$/u, '')
  }

  async function fetchCookieFromConnection() {
    const connection = ctx.get('connection')
    if (!connection || typeof connection.authenticatedUrl !== 'function') return ''
    const origin = localOrigin()
    const authUrl = new URL(connection.authenticatedUrl(origin))
    const cookie = await new Promise((resolve, reject) => {
      const request = http.get(
        {
          host: authUrl.hostname,
          port: authUrl.port || 80,
          path: `${authUrl.pathname}${authUrl.search}`,
          agent: false,
          timeout: 10_000,
          headers: {
            host: authUrl.host,
            accept: 'text/html',
            'accept-encoding': 'identity',
          },
        },
        (response) => {
          const setCookie = response.headers['set-cookie']
          response.resume()
          if (Array.isArray(setCookie) && setCookie.length > 0) resolve(String(setCookie[0]).split(';')[0])
          else resolve('')
        },
      )
      request.on('timeout', () => request.destroy(new Error('timed out acquiring the local browser session')))
      request.on('error', reject)
    })
    return cookie
  }

  function mintFromCredentials() {
    const origin = localOrigin()
    const secret = readBrowserSecret(dshHome())
    return mintBrowserCookie(secret, new URL(origin).host)
  }

  /**
   * The cookie the gateway presents to the local Harness. Always for the
   * loopback authority, never the remote browser's own cookies.
   */
  async function getCookie() {
    if (cachedCookie !== '' && Date.now() - cachedAt < COOKIE_CACHE_MS) return cachedCookie
    if (!pendingCookie) {
      pendingCookie = (async () => {
        let cookie = ''
        try {
          cookie = await fetchCookieFromConnection()
        } catch (error) {
          log(`connection-based login failed, falling back to credential minting: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (cookie === '') cookie = mintFromCredentials()
        if (cookie === '') throw new Error('could not obtain a local Harness browser session')
        cachedCookie = cookie
        cachedAt = Date.now()
        return cookie
      })().finally(() => {
        pendingCookie = undefined
      })
    }
    return pendingCookie
  }

  function invalidateCookie() {
    cachedCookie = ''
    cachedAt = 0
  }

  const scheduleRetry = (delayMs) => {
    if (disposed) return
    clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      void start()
    }, delayMs)
    retryTimer.unref?.()
  }

  // ---------------------------------------------------------------------------
  // Settings page support: URLs, QR code and token refresh.
  // ---------------------------------------------------------------------------

  /**
   * Candidate entry URLs: live tunnel first, then the public address, then LAN.
   * Each source is gated on its own flag, so a tunnel can be listed while the
   * saved public address stays off.
   */
  /** A secret the panel saved into the state dir, or ''. */
  function readStateText(name) {
    try {
      const file = join(config.stateDir, name)
      return existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
    } catch {
      return ''
    }
  }

  /**
   * Reach the fixed hostname from the outside, through Cloudflare Access when a
   * service token is configured. This is the only honest way to tell "隧道在跑"
   * apart from "域名真的能打开".
   * @returns {Promise<{ok:boolean, detail:string, status:number, url:string}>}
   */
  async function checkNamedTunnel() {
    const hostname = tunnel.status().hostname
    if (hostname === '') {
      return { ok: false, detail: '先填域名并保存固定隧道', status: 0, url: '' }
    }
    const url = `https://${hostname}/__webim/ping`
    const headers = accessHeaders(readStateText('access-client-id.txt'), readStateText('access-client-secret.txt'))
    try {
      const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(8_000) })
      const body = await response.text()
      if (response.status === 200) {
        let version = ''
        try {
          version = JSON.parse(body).version || ''
        } catch {
          // a 200 that is not our ping is still "reachable but wrong"
        }
        return {
          ok: true,
          detail: version === '' ? '域名已连通' : `域名已连通，插件版本 ${version}`,
          status: 200,
          url,
        }
      }
      return { ok: false, detail: describeCheckFailure({ status: response.status }), status: response.status, url }
    } catch (error) {
      const code = (error && error.cause && error.cause.code) || (error && error.code) || ''
      return { ok: false, detail: describeCheckFailure({ code }), status: 0, url }
    }
  }

  function entryUrls() {
    if (!remoteOn()) return []
    return accessUrls({
      port: boundPort,
      publicUrl: publicOn() ? publicUrls.current() || config.publicUrl : '',
      tunnelUrl: tunnelOn() ? tunnel.status().url : '',
      token: tokens.current(),
      includeLoopback: false,
      includeLan: lanOn(),
    })
  }

  /** Lazy QR import: the encoder is only loaded when a settings page asks for it. */
  let qrModule
  async function qrFor(url) {
    try {
      qrModule ??= await import('./qr.js')
      const svg = qrModule.renderSvg(url, { ecc: 'M', scale: 6, margin: 4 })
      const matrix = qrModule.qrMatrix(url, { ecc: 'M' })
      return { svg, size: matrix.size, version: matrix.version, mask: matrix.mask }
    } catch (error) {
      log(`QR generation unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  async function detectPublicAddress() {
    const response = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(6000),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`public address lookup failed: HTTP ${response.status}`)
    const body = await response.json()
    const ip = typeof body?.ip === 'string' ? body.ip.trim() : ''
    if (!/^[0-9a-fA-F:.]+$/u.test(ip) || ip.length < 3) throw new Error('public address lookup returned an unexpected value')
    return publicUrls.set(`http://${ip}:${boundPort}`)
  }

  /** Payload shared by `info`, `refresh`, `setPublicUrl` and `detectPublicUrl`. */
  async function statusPayload() {
    const urls = entryUrls()
    const target = resolveQrTarget(urls, qrTargets.current())
    const qr = !target || target.tokenUrl === '' ? null : await qrFor(target.tokenUrl)
    const stats = gateway?.stats ?? { requests: 0, proxied: 0, logins: 0, rejected: 0, wsActive: 0, wsTotal: 0 }
    return {
      version: VERSION,
      gateway: {
        running: Boolean(gateway),
        disabled: !remoteOn(),
        host: bindHost(),
        port: boundPort,
        upstream: gateway?.upstreamOrigin ?? localOriginSafe(),
        sessionDays: config.sessionDays,
        injectClient: config.injectClient,
        linkifyPaths: features.enabled('linkifyPaths'),
      },
      reach: {
        lan: lanOn(),
        public: publicOn(),
        tunnel: tunnelOn(),
      },
      features: {
        values: features.get(),
        defs: FEATURE_DEFS.map(({ key, label, hint }) => ({ key, label, hint, default: features.defaultFor(key) })),
      },
      tunnel: { ...tunnel.status(), starting: tunnel.starting === true },
      mobile: { layout: features.enabled('mobileUi') },
      access: {
        token: tokens.current(),
        tokenConfigured: tokens.configured,
        createdAt: tokens.info().createdAt,
        rotatedAt: tokens.info().rotatedAt,
        urls: urls.map((entry) => ({ ...entry, isQrTarget: entry.id === target?.id })),
        primaryId: target?.id ?? '',
        qrTargetId: target?.id ?? '',
        qr,
      },
      publicAddress: {
        current: publicUrls.current() || config.publicUrl,
        configured: config.publicUrl,
        saved: publicUrls.current(),
      },
      security: {
        passwordEnabled: config.passwordEnabled,
        passwordLength: config.passwordEnabled ? config.password.length : 0,
        weakPassword: config.passwordEnabled && config.password.length < 8,
        secureCookies: config.secureCookies,
        allowIPs: config.allowIPs,
        blocked: gateway ? gateway.blockedClients() : [],
      },
      stats,
    }
  }

  function localOriginSafe() {
    try {
      return localOrigin()
    } catch {
      return ''
    }
  }

  /**
   * Answer one decoded endpoint call on the shared channel.
   * @param {string} endpoint
   * @param {unknown} payload
   */
  async function handleCall(endpoint, payload) {
    try {
      if (endpoint === 'info') return { ok: true, value: await statusPayload() }
      if (endpoint === 'refresh') {
        if (tokens.configured) {
          return {
            ok: false,
            error: {
              code: 'token-pinned',
              message: '入口令牌由插件配置中的 accessToken 固定，删除该配置项后才能在此刷新。',
              details: {},
            },
          }
        }
        tokens.rotate()
        log('access token refreshed from Settings')
        return { ok: true, value: await statusPayload() }
      }
      if (endpoint === 'setTunnelNamed') {
        const request = payload && typeof payload === 'object' ? payload : {}
        try {
          await tunnel.setNamed({
            mode: typeof request.mode === 'string' ? request.mode : undefined,
            hostname: typeof request.hostname === 'string' ? request.hostname : undefined,
            token: typeof request.token === 'string' ? request.token : undefined,
          })
        } catch (error) {
          return {
            ok: false,
            error: {
              code: 'named-tunnel',
              message: error instanceof Error ? error.message : String(error),
              details: {},
            },
          }
        }
        log(`named tunnel: ${tunnel.status().mode} ${tunnel.status().hostname || '(quick)'}`)
        // A mode/hostname change only takes effect on a fresh process.
        if (tunnelOn()) {
          if (tunnel.running || tunnel.starting) await tunnel.stop()
          void tunnel.start().catch((error) => {
            log(`cloudflare tunnel failed: ${error instanceof Error ? error.message : String(error)}`)
          })
        }
        return { ok: true, value: await statusPayload() }
      }
      if (endpoint === 'checkNamed') {
        const check = await checkNamedTunnel()
        log(`fixed tunnel self-check: ${check.ok ? 'ok' : 'failed'} — ${check.detail}`)
        return { ok: true, value: { ...(await statusPayload()), check } }
      }
      if (endpoint === 'setPublicUrl') {
        const request = payload && typeof payload === 'object' ? payload : {}
        const saved = publicUrls.set(typeof request.url === 'string' ? request.url : '')
        log(`public address ${saved === '' ? 'cleared' : `set to ${saved}`}`)
        return { ok: true, value: await statusPayload() }
      }
      if (endpoint === 'detectPublicUrl') {
        const saved = await detectPublicAddress()
        log(`public address detected as ${saved}`)
        return { ok: true, value: await statusPayload() }
      }
      if (endpoint === 'setQrTarget') {
        const request = payload && typeof payload === 'object' ? payload : {}
        const wanted = typeof request.id === 'string' ? request.id : ''
        const known = entryUrls().some((entry) => entry.id === wanted)
        if (wanted !== '' && !known) {
          return {
            ok: false,
            error: { code: 'unknown-entry', message: '这个入口已经不存在了，刷新后再选。', details: {} },
          }
        }
        const saved = qrTargets.set(wanted)
        log(`QR target ${saved === '' ? 'reset to the first entry' : `set to ${saved}`}`)
        return { ok: true, value: await statusPayload() }
      }
      if (endpoint === 'setFeatures') {
        const request = payload && typeof payload === 'object' ? payload : {}
        const patch = request.features && typeof request.features === 'object' ? request.features : request
        const result = features.set(patch)
        if (result.changed.length > 0) {
          log(`features changed: ${result.changed.join(', ')}`)
          // Queued, not awaited: see applyFeatureEffects.
          void applyFeatureEffects(result.changed)
        }
        return { ok: true, value: await statusPayload() }
      }
      if (endpoint === 'resetFeatures') {
        const result = features.reset()
        log('feature switches reset to the configured defaults')
        if (result.changed.length > 0) void applyFeatureEffects(result.changed)
        return { ok: true, value: await statusPayload() }
      }
      if (endpoint === 'tunnelStart') {
        if (!tunnelOn()) {
          return {
            ok: false,
            error: { code: 'tunnel-off', message: '隧道开关没打开，先选「Cloudflare 隧道」再开。', details: {} },
          }
        }
        if (tunnel.running || tunnel.starting) return { ok: true, value: await statusPayload() }
        // Do not block the reply: fetching cloudflared and waiting for the URL
        // can take 20 s or more. The panel polls `info` and shows the progress.
        void tunnel.start().then(
          (status) => log(`tunnel started: ${status.url}`),
          (error) => {
            const message = error instanceof Error ? error.message : String(error)
            // A stop the owner asked for is not a failure worth flagging.
            log(message.startsWith('cloudflared was stopped') ? `tunnel cancelled: ${message}` : `tunnel failed: ${message}`)
          },
        )
        return { ok: true, value: await statusPayload() }
      }
      if (endpoint === 'tunnelStop') {
        await tunnel.stop()
        log('tunnel stopped by the owner')
        return { ok: true, value: await statusPayload() }
      }
      return {
        ok: false,
        error: { code: 'not-found', message: `Unknown endpoint ${JSON.stringify(endpoint)}.`, details: {} },
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: typeof error?.code === 'string' ? error.code : 'webim-error',
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
      }
    }
  }

  /** Prefer the connection service's channel registry; fall back to our own route. */
  function installRpc() {
    try {
      const connection = ctx.get('connection')
      if (connection && typeof connection.rpc?.handle === 'function') {
        const disposer = connection.rpc.handle(CHANNEL, (endpoint, payload) => handleCall(endpoint, payload))
        ctx.effect(() => disposer, 'dsh-webim: settings rpc channel')
        return
      }
    } catch (error) {
      log(`connection RPC channel unavailable, serving it from the web server instead: ${error instanceof Error ? error.message : String(error)}`)
    }
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: CHANNEL,
      handler: async (req, res) => {
        try {
          const rejection = ctx.connection?.requestRejection?.({ headers: req.headers })
          if (rejection !== undefined) {
            res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
            return
          }
          if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('method not allowed')
            return
          }
          const chunks = []
          let size = 0
          for await (const chunk of req) {
            size += chunk.length
            if (size > BODY_LIMIT_BYTES) throw new Error('request body too large')
            chunks.push(chunk)
          }
          const message = size === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
          const endpoint = decodeURIComponent(pathname.slice(CHANNEL.length).replace(/^\/+/u, ''))
          const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
          if (message?.type !== 'client-request' || typeof message.method !== 'string') {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'bad-request', message: 'bad client-request envelope', details: {} } } }))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ type: 'server-response', rpcId, result: await handleCall(endpoint, message.payload) }))
        } catch (error) {
          log(`settings rpc route failed: ${error instanceof Error ? error.message : String(error)}`)
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ type: 'server-response', rpcId: 'invalid-request', result: { ok: false, error: { code: 'internal', message: String(error), details: {} } } }))
          } else {
            res.destroy()
          }
        }
      },
    }), 'dsh-webim: settings rpc route')
  }

  /** Process-wide pointer to the live gateway, shared across hot reloads. */
  function closeRegisteredGateway() {
    const previous = globalThis[GATEWAY_REGISTRY]
    globalThis[GATEWAY_REGISTRY] = undefined
    if (!previous || typeof previous.close !== 'function') return
    try {
      Promise.resolve(previous.close()).catch(() => {})
    } catch {
      // best effort: a dead gateway cannot answer anyway
    }
  }

  /**
   * Record where this instance runs and which token it serves.   *
   * Two gateway generations can briefly coexist while the host hot-reloads the
   * plugin, and then "my link stopped working" is really "another instance owns
   * port 3081". This file makes that visible in one glance.
   */
  function writeStartRecord({ port }) {
    try {
      mkdirSync(config.stateDir, { recursive: true, mode: 0o700 })
      writeFileSync(
        join(config.stateDir, 'last-start.json'),
        `${JSON.stringify({
          version: VERSION,
          pid: process.pid,
          stateDir: config.stateDir,
          port,
          token: tokens.current(),
          pinned: tokens.configured,
          tokenError: tokens.lastError ?? '',
          startedAt: new Date().toISOString(),
        }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
    } catch (error) {
      log(`could not write last-start.json: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function start() {
    if (disposed) return
    if (!remoteOn()) {
      log('remote entry is switched off (features.enabled = false); nothing is listening')
      return
    }
    let origin
    try {
      origin = localOrigin()
    } catch {
      // The web carrier has not bound its port yet; try again shortly.
      scheduleRetry(500)
      return
    }

    try {
      // Windows lets a second socket bind an address another socket already
      // owns (SO_REUSEADDR), so a hot reload can leave two gateways on the same
      // port answering with different tokens. Retire the previous instance
      // through a process-wide registry before binding ours.
      closeRegisteredGateway()
      gateway = createGateway({
        config: { ...config, host: bindHost() },
        upstreamOrigin: origin,
        getCookie,
        invalidateCookie,
        tokenStore: tokens,
        features: () => features.get(),
        log,
      })
      const address = await gateway.listen()
      boundPort = address.port
      globalThis[GATEWAY_REGISTRY] = gateway
      writeStartRecord({ port: address.port })
      const shownHost = bindHost() === '0.0.0.0' ? '0.0.0.0' : address.address
      log(`remote entry listening on http://${shownHost}:${address.port} (${config.passwordEnabled ? 'password + token' : 'token-only'} gate on, upstream ${gateway.upstreamOrigin})`)
      if (!lanOn()) log('LAN entry is off: bound to loopback only, other devices cannot reach it')
      const urls = entryUrls()
      const primary = urls[0]
      if (primary) log(`entry link: ${primary.tokenUrl}`)
      if (tunnelOn()) {
        tunnel.start().then((status) => {
          log(`cloudflare tunnel: ${status.url}`)
        }).catch((error) => {
          log(`cloudflare tunnel failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : ''
      if (code === 'EADDRINUSE') {
        log(`port ${config.port} is busy (another dsh-webim instance or gateway is running); retrying in 10s`)
        scheduleRetry(10_000)
        return
      }
      log(`failed to start: ${error instanceof Error ? error.message : String(error)}`)
      scheduleRetry(15_000)
    }
  }

  /** Close the listener without touching the plugin lifetime. */
  async function stopListener() {
    const current = gateway
    gateway = undefined
    boundPort = 0
    if (!current) return
    if (globalThis[GATEWAY_REGISTRY] === current) globalThis[GATEWAY_REGISTRY] = undefined
    try {
      await current.close()
    } catch (error) {
      log(`could not close the entry listener: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Apply the side effects of a switch change: stop or restart the listener when
   * the binding changed, and start/stop the tunnel to match the new gates.
   *
   * The work is queued and NOT awaited by the caller: closing the listener takes
   * up to a few seconds (live sockets are drained), which is longer than the
   * Settings RPC round trip, so awaiting it made the panel report "the host
   * plugin did not respond" right after a switch had in fact been applied.
   * @param {string[]} changed feature keys that actually changed
   * @returns {Promise<void>} resolves when the queued work is done
   */
  function applyFeatureEffects(changed) {
    // Only the master switch and the LAN entry change the bound address; the
    // public address and the tunnel are entry-list concerns and never rebind.
    const touchesReach = changed.some((key) => key === 'enabled' || key === 'lan')
    const touchesTunnel = changed.includes('tunnel')

    reachQueue = reachQueue
      .then(async () => {
        if (!tunnelOn()) await tunnel.stop().catch(() => {})
        if (touchesReach) {
          clearTimeout(retryTimer)
          await stopListener()
          if (remoteOn()) await start()
        }
        if ((touchesTunnel || touchesReach) && tunnelOn() && tunnel.starting !== true) {
          try {
            const status = await tunnel.start()
            log(`cloudflare tunnel: ${status.url}`)
          } catch (error) {
            log(`cloudflare tunnel failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      })
      .catch((error) => {
        log(`could not apply the feature switch: ${error instanceof Error ? error.message : String(error)}`)
      })
    return reachQueue
  }

  installRpc()

  ctx.effect(() => {
    void start()
    return () => {
      disposed = true
      clearTimeout(retryTimer)
      tunnel.dispose()
      if (gateway) {
        if (globalThis[GATEWAY_REGISTRY] === gateway) globalThis[GATEWAY_REGISTRY] = undefined
        Promise.resolve(gateway.close()).catch(() => {})
        gateway = undefined
      }
    }
  })
}
