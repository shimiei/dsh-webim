import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Standalone-mode bridge credential.
 *
 * The in-process plugin authenticates to the local Harness through
 * `ctx.connection.authenticatedUrl()`; when dsh-webim runs as a separate
 * process (bin/serve.mjs) there is no Cordis context, so this module mints
 * the same type of browser-session cookie the Harness itself would mint,
 * reading the durable signing secret from $DSH_HOME/.credentials.yaml
 * (record `client-connection/browser-session`, payload.version 1).
 *
 * Cookie format (mirrors @deepseek-ai/dsh-client-connection BrowserAuth):
 *   name  = "dsh-auth-" + base64url(sha256(authority))
 *   value = "v1." + base64url(json{version,authority,issuedAt,expiresAt}) + "." +
 *           base64url(hmac_sha256(secret, body))
 */
const COOKIE_PREFIX = 'dsh-auth-'
const DAY_MS = 24 * 60 * 60 * 1000

function b64url(data) {
  return Buffer.from(data).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function yamlBlockSecret(text) {
  const lines = text.split(/\r?\n/u)
  const start = lines.findIndex((line) => /^ {2}client-connection\/browser-session:\s*$/u.test(line))
  if (start === -1) return undefined
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    if (!/^\s/u.test(line)) return undefined
    const secretMatch = /^\s+secret:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/u.exec(line)
    if (!secretMatch) continue
    const raw = secretMatch[1]
    const decoded = Buffer.from(
      raw.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (raw.length % 4)) % 4),
      'base64',
    )
    return decoded.length === 32 ? decoded : undefined
  }
  return undefined
}

/** Read the Harness browser-session signing secret. */
export function readBrowserSecret(home) {
  const file = join(home, '.credentials.yaml')
  const text = readFileSync(file, 'utf8')
  const secret = yamlBlockSecret(text)
  if (!secret) throw new Error(`could not read client-connection/browser-session secret from ${file}`)
  return secret
}

/** Mint the `Cookie` header value the local Harness accepts for `authority` (host:port). */
export function mintBrowserCookie(secret, authority, { days = 30, now = Date.now() } = {}) {
  const name = COOKIE_PREFIX + b64url(createHash('sha256').update(authority).digest())
  const issuedAt = now
  const expiresAt = now + days * DAY_MS
  const payload = { version: 1, authority, issuedAt, expiresAt }
  const body = b64url(JSON.stringify(payload))
  const mac = b64url(createHmac('sha256', secret).update(body).digest())
  return `${name}=v1.${body}.${mac}`
}
