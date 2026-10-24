#!/usr/bin/env node
/**
 * dsh-webim standalone launcher.
 *
 * Runs the same gateway as the Cordis plugin, but as its own process. Useful
 * for trying the remote entry immediately, and for hosts where adding a
 * profile bundle is inconvenient.
 *
 * The plugin mode is preferred in normal use: it lives inside the Harness
 * process, obtains the local browser session from `ctx.connection`, and never
 * has to read `$DSH_HOME/.credentials.yaml` itself.
 *
 * Usage:
 *   node bin/serve.mjs --port 3081 --password "a-strong-secret"
 *   node bin/serve.mjs --upstream http://127.0.0.1:50912 --host 0.0.0.0
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import process from 'node:process'
import { normalizeConfig } from '../lib/config.js'
import { createGateway } from '../lib/gateway.js'
import { mintBrowserCookie, readBrowserSecret } from '../lib/credentials.js'
import { accessUrls } from '../lib/urls.js'
import { VERSION } from '../lib/version.js'

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') {
      options.help = true
      continue
    }
    if (!token.startsWith('--')) continue
    const [rawKey, inlineValue] = token.slice(2).split('=')
    const key = rawKey.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())
    const readValue = () => {
      if (inlineValue !== undefined) return inlineValue
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) return ''
      index += 1
      return next
    }
    switch (key) {
      case 'port':
      case 'host':
      case 'password':
      case 'upstream':
      case 'home':
      case 'sessionDays':
      case 'allowedRoots':
      case 'stateDir':
      case 'publicUrl':
      case 'accessToken':
        options[key] = readValue()
        break
      case 'noLinkifyPaths':
        options.linkifyPaths = false
        break
      case 'logRequests':
      case 'secureCookies':
        options[key] = readValue() !== 'false'
        break
      case 'allowIps':
        options.allowIPs = readValue().split(',').map((item) => item.trim()).filter(Boolean)
        break
      default:
        break
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))

if (options.help) {
  process.stdout.write(`dsh-webim v${VERSION} — standalone remote entry

Options:
  --host <addr>             listen address (default 0.0.0.0)
  --port <port>             listen port (default 3081)
  --password <value>
                          entry password; omit or pass '' for token-only
  --access-token <value>    pin the token entry link (default: generated and persisted)
  --upstream <url>          local Harness origin (default $DSH_WEB_URL or http://127.0.0.1:50912)
  --home <dir>              DSH home used for credentials/state (default $DSH_HOME)
  --session-days <n>        login lifetime in days (default 30)
  --allowed-roots <a,b>     restrict /__webim/fs to these absolute roots
  --allow-ips <a,b>         restrict clients to these addresses
  --public-url <url>        advertised URL (status only)
  --state-dir <dir>         gateway state directory (default $DSH_HOME/webim)
  --no-linkify-paths        do not linkify local paths in the UI
  --log-requests            log every proxied request
  --secure-cookies          always set Secure on the session cookie (TLS in front)
`)
  process.exit(0)
}

const home = options.home || process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
const upstreamRaw = options.upstream || process.env.DSH_WEB_URL || 'http://127.0.0.1:50912'
let upstream
try {
  upstream = new URL(upstreamRaw)
  if (!['http:', 'https:'].includes(upstream.protocol)) throw new Error('upstream must be http(s)')
} catch (error) {
  process.stderr.write(`invalid --upstream: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(2)
}

const stateDir = options.stateDir || join(home, 'webim')
const config = normalizeConfig({
  enabled: true,
  host: options.host || '0.0.0.0',
  port: options.port === undefined || options.port === '' ? 3081 : options.port,
  // '' keeps the password door off (token-only), matching the plugin default.
  password: typeof options.password === 'string' ? options.password : '',
  sessionDays: options.sessionDays ?? 30,
  stateDir,
  allowedRoots: options.allowedRoots
    ? options.allowedRoots.split(/[,;]/u).map((item) => item.trim()).filter(Boolean)
    : [],
  allowIPs: options.allowIPs ?? [],
  features: { linkifyPaths: options.linkifyPaths !== false },
  logRequests: Boolean(options.logRequests),
  publicUrl: options.publicUrl || '',
  accessToken: options.accessToken || '',
  secureCookies: Boolean(options.secureCookies),
})

const authority = upstream.host
const origin = upstream.origin
let cachedCookie = ''

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`)
}

async function getCookie() {
  if (cachedCookie !== '') return cachedCookie
  const secret = readBrowserSecret(home)
  cachedCookie = mintBrowserCookie(secret, authority)
  return cachedCookie
}

function invalidateCookie() {
  cachedCookie = ''
}

const gateway = createGateway({
  config,
  upstreamOrigin: origin,
  getCookie,
  invalidateCookie,
  log: (message) => log(message),
})

function writeState(address) {
  try {
    mkdirSync(stateDir, { recursive: true })
    const stateFile = join(stateDir, 'standalone.json')
    writeFileSync(
      stateFile,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), origin, address, version: VERSION }, null, 2)}\n`,
    )
  } catch (error) {
    log(`could not write standalone state: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function clearState() {
  try {
    const stateFile = join(stateDir, 'standalone.json')
    if (!existsSync(stateFile)) return
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (saved.pid === process.pid) unlinkSync(stateFile)
  } catch {
    // best effort
  }
}

let stopping = false
async function shutdown(signal) {
  if (stopping) return
  stopping = true
  log(`${signal}: shutting down`)
  clearState()
  await gateway.close().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

try {
  const address = await gateway.listen()
  writeState(address)
  const urls = accessUrls({ port: address.port, publicUrl: config.publicUrl, token: gateway.tokenStore.current(), includeLoopback: true })
  log(`dsh-webim v${VERSION} remote entry is up`)
  log(`  upstream : ${origin}`)
  log(`  listen   : ${config.host}:${address.port}`)
  for (const entry of urls) {
    const label = entry.kind === 'public' ? 'public' : entry.kind === 'lan' ? 'lan   ' : entry.kind === 'tunnel' ? 'tunnel' : 'local '
    log(`  ${label}   : ${entry.url}`)
  }
  const primary = urls[0]
  log(`  token    : ${primary.tokenUrl}`)
  log('  (token entry skips the password; refresh it from Settings once the plugin is installed)')
  log(`  password : ${config.passwordEnabled ? `${config.password.length} characters` : 'disabled (token-only entry)'}`)
  if (config.passwordEnabled && config.password.length < 8 && config.host !== '127.0.0.1' && config.host !== '::1') {
    log('  WARNING  : password is weak while the listener is reachable from the network')
  }
  if (!upstream.protocol.startsWith('https')) {
    log('  NOTE     : traffic to the local Harness is plain loopback HTTP; remote browsers use HTTP unless a TLS proxy fronts this port')
  }

  const probe = await new Promise((resolve) => {
    const started = Date.now()
    getCookie()
      .then((cookie) => {
          const request = http.get(
            { host: upstream.hostname, port: upstream.port || 80, path: '/', headers: { host: authority, cookie, 'accept-encoding': 'identity' }, timeout: 5000 },
            (response) => {
              response.resume()
              resolve({ ok: response.statusCode === 200, status: response.statusCode, ms: Date.now() - started })
            },
          )
          request.on('timeout', () => request.destroy(new Error('timeout')))
          request.on('error', (error) => resolve({ ok: false, error: error.message }))
      })
      .catch((error) => resolve({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  })
  if (probe.ok) log(`  upstream check: OK (${probe.ms}ms)`)
  else log(`  upstream check: FAILED ${probe.status ?? ''} ${probe.error ?? ''} — is the local Harness running on ${origin}?`)
} catch (error) {
  log(`failed to start: ${error instanceof Error ? error.message : String(error)}`)
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
    log(`port ${config.port} is already in use; stop the other instance first`)
  }
  process.exit(1)
}

