import http from 'node:http'
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib'
import { URL } from 'node:url'
import { renderError } from './pages.js'
import { VERSION } from './version.js'

/** Headers that must never be forwarded verbatim in either direction. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function filterHeaders(source, extraDrop = []) {
  const drop = new Set([...HOP_BY_HOP, ...extraDrop])
  const out = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (drop.has(key.toLowerCase())) continue
    out[key] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return out
}

/**
 * Decode a compressed upstream body. The gateway asks for `identity` on
 * documents it wants to rewrite, but a non-compliant upstream may still
 * compress; HTML injection must never touch encoded bytes.
 * @returns {Buffer|null} decoded body, or null when the encoding is unknown
 */
function decodeBody(buffer, encoding) {
  const value = String(encoding || '').trim().toLowerCase()
  if (value === '' || value === 'identity') return buffer
  try {
    if (value === 'gzip' || value === 'x-gzip') return gunzipSync(buffer)
    if (value === 'deflate') {
      try {
        return inflateSync(buffer)
      } catch {
        return inflateRawSync(buffer)
      }
    }
    if (value === 'br') return brotliDecompressSync(buffer)
  } catch {
    return null
  }
  return null
}

/** Rewrite absolute upstream URLs in a Location header to gateway-relative paths. */function rewriteLocation(value, origin) {
  if (typeof value !== 'string' || value === '') return value
  if (!value.startsWith(origin)) return value
  const rest = value.slice(origin.length)
  return rest === '' ? '/' : rest
}

function sendGatewayError(res, status, title, message, detail = '') {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = renderError({ title, message, detail, status })
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/** Is this the document request whose HTML needs the dsh-webim client add-on? */
function shouldInject(req) {
  if (req.method !== 'GET') return false
  const pathname = (() => {
    try {
      return new URL(req.url, 'http://gateway.invalid').pathname
    } catch {
      return ''
    }
  })()
  if (pathname !== '/' && pathname !== '/index.html') return false
  return true
}

const CLIENT_STYLE = '/__webim/client.css'
const CLIENT_SCRIPT = '/__webim/client.js'
const VIEWPORT_CONTENT = 'width=device-width, initial-scale=1, viewport-fit=cover'
const MOBILE_META = [
  '<meta name="theme-color" content="#16171b">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
  '<meta name="format-detection" content="telephone=no">',
].join('')

/**
 * Inject the add-on assets, plus the phone viewport when the mobile layout is on.
 * A missing or desktop-only viewport tag is rewritten so pinch-zoom keeps working.
 * @param {string} html upstream document
 * @param {{mobile?: boolean}} [options]
 */
function injectIntoHtml(html, { mobile = true } = {}) {
  const headTags = `<link rel="stylesheet" href="${CLIENT_STYLE}?v=${VERSION}">${mobile ? MOBILE_META : ''}`
  const bodyTags = `<script src="${CLIENT_SCRIPT}?v=${VERSION}" defer></script>`
  let output = html
  if (mobile) {
    if (/<meta[^>]+name=["']viewport["'][^>]*>/iu.test(output)) {
      output = output.replace(/<meta[^>]+name=["']viewport["'][^>]*>/iu, `<meta name="viewport" content="${VIEWPORT_CONTENT}">`)
    } else {
      output = output.replace(/<head[^>]*>/iu, (match) => `${match}<meta name="viewport" content="${VIEWPORT_CONTENT}">`)
    }
  }
  if (output.includes('</head>')) output = output.replace('</head>', `${headTags}</head>`)
  else output = headTags + output
  if (output.includes('</body>')) output = output.replace('</body>', `${bodyTags}</body>`)
  else output += bodyTags
  return output
}

/**
 * Build the reverse proxy to the local Harness.
 *
 * @param {object} deps
 * @param {string} deps.origin   e.g. http://127.0.0.1:50912
 * @param {() => Promise<string>} deps.getCookie  upstream Cookie header value
 * @param {() => void} deps.invalidateCookie      drop the cached credential (after 401)
 * @param {(line: string) => void} [deps.log]
 * @param {boolean} [deps.injectClient]
 */
export function createProxy({ origin, getCookie, invalidateCookie, log = () => {}, injectClient = true, mobileUi = true }) {
  const target = new URL(origin)
  const authority = target.host
  const targetOrigin = target.origin
  const mobileOn = typeof mobileUi === 'function' ? () => Boolean(mobileUi()) : () => mobileUi !== false
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16, timeout: 60_000 })

  function requestHeaders(req, cookie) {
    const headers = filterHeaders(req.headers, [
      'host',
      'cookie',
      'origin',
      'referer',
      'x-forwarded-for',
      'x-forwarded-host',
      'x-forwarded-proto',
      'x-real-ip',
      'cf-connecting-ip',
      'cf-ipcountry',
      'cdn-loop',
      'forwarded',
    ])
    headers.host = authority
    headers.origin = targetOrigin
    headers.cookie = cookie
    if (shouldInject(req)) headers['accept-encoding'] = 'identity'
    return headers
  }

  function responseHeaders(upstreamRes, req) {
    // `content-encoding` must survive: the body is piped through untouched, so
    // dropping the header would hand gzip/br/zstd bytes to the browser as if
    // they were text (that is exactly how every JS bundle turned into
    // "SyntaxError: Invalid or unexpected token" and the app rendered blank).
    const headers = filterHeaders(upstreamRes.headers, ['set-cookie', 'content-length', 'etag'])
    if (headers.location) headers.location = rewriteLocation(headers.location, targetOrigin)
    if (req && shouldInject(req)) headers['cache-control'] = 'no-store'
    return headers
  }

  function proxyHttp(req, res) {
    const retryable = req.method === 'GET' || req.method === 'HEAD'
    let attempt = 0
    let finished = false

    const finish = () => {
      if (finished) return
      finished = true
    }

    const go = async () => {
      let cookie
      try {
        cookie = await getCookie()
      } catch (error) {
        log(`upstream credential unavailable: ${error instanceof Error ? error.message : String(error)}`)
        sendGatewayError(
          res,
          502,
          'Harness 未就绪',
          '无法连接本机 DeepSeek Harness（获取本机登录凭据失败）。',
          error instanceof Error ? error.message : String(error),
        )
        finish()
        return
      }

      const upReq = http.request({
        host: target.hostname,
        port: target.port || 80,
        method: req.method,
        path: req.url,
        headers: requestHeaders(req, cookie),
        agent,
      })

      let settled = false
      const settle = () => {
        if (settled) return false
        settled = true
        return true
      }

      upReq.on('response', async (upRes) => {
        if (!settle()) return
        if (upRes.statusCode === 401 && attempt === 0 && retryable) {
          upRes.resume()
          invalidateCookie()
          attempt += 1
          go()
          return
        }
        if (upRes.statusCode === 401 && !retryable) {
          upRes.resume()
          sendGatewayError(res, 401, '需要重新登录', '本机 Harness 拒绝了网关的登录态，请稍后刷新页面重试。')
          finish()
          return
        }

        const inject = injectClient && shouldInject(req) && (upRes.headers['content-type'] || '').includes('text/html')
        if (inject) {
          const chunks = []
          let size = 0
          upRes.on('data', (chunk) => {
            size += chunk.length
            if (size > 8 * 1024 * 1024) {
              // Unexpectedly huge HTML: stop buffering and degrade to plain pass-through.
              res.writeHead(upRes.statusCode, responseHeaders(upRes, req))
              for (const buffered of chunks) res.write(buffered)
              res.write(chunk)
              upRes.pipe(res)
              chunks.length = 0
              return
            }
            chunks.push(chunk)
          })
          upRes.on('end', () => {
            if (chunks.length === 0) return
            const raw = Buffer.concat(chunks)
            const decoded = decodeBody(raw, upRes.headers['content-encoding'])
            if (!decoded) {
              // Unknown encoding: forward untouched instead of corrupting it.
              const passthrough = responseHeaders(upRes, req)
              passthrough['content-length'] = String(raw.length)
              res.writeHead(upRes.statusCode, passthrough)
              res.end(raw)
              finish()
              return
            }
            const html = decoded.toString('utf8')
            const body = Buffer.from(injectIntoHtml(html, { mobile: mobileOn() }), 'utf8')
            const headers = responseHeaders(upRes, req)
            headers['content-type'] = 'text/html; charset=utf-8'
            headers['content-length'] = String(body.length)
            // The injected document is re-encoded as plain UTF-8 above.
            delete headers['content-encoding']
            res.writeHead(upRes.statusCode, headers)
            res.end(body)
            finish()
          })
          upRes.on('error', (error) => {
            log(`upstream html stream error: ${error.message}`)
            res.destroy(error)
            finish()
          })
          return
        }

        res.writeHead(upRes.statusCode, responseHeaders(upRes, req))
        upRes.pipe(res)
        upRes.on('error', (error) => {
          log(`upstream response error: ${error.message}`)
          res.destroy(error)
        })
        res.on('close', () => {
          if (!upRes.complete) upRes.destroy()
          finish()
        })
      })

      upReq.on('error', (error) => {
        if (!settle()) return
        log(`upstream request error: ${error.code || error.message}`)
        sendGatewayError(
          res,
          502,
          'Harness 未就绪',
          '无法连接本机 DeepSeek Harness，可能还在启动中。',
          `${error.code || ''} ${error.message || String(error)}`.trim(),
        )
        finish()
      })

      req.on('aborted', () => upReq.destroy())
      req.pipe(upReq)
    }

    go().catch((error) => {
      log(`proxy failure: ${error instanceof Error ? error.message : String(error)}`)
      sendGatewayError(res, 500, '网关错误', 'dsh-webim 转发请求时发生异常。', error instanceof Error ? error.message : String(error))
      finish()
    })
  }

  function forwardUpgrade(req, socket, head) {
    let closed = false
    let upSocket = null
    const closeBoth = () => {
      if (closed) return
      closed = true
      if (upSocket) {
        upSocket.destroy()
        upSocket = null
      }
      socket.destroy()
    }

    socket.on('error', closeBoth)
    socket.on('close', closeBoth)

    getCookie().then(
      (cookie) => {
        const headers = requestHeaders(req, cookie)
        headers.connection = 'Upgrade'
        headers.upgrade = req.headers.upgrade || 'websocket'
        const upReq = http.request({
          host: target.hostname,
          port: target.port || 80,
          method: req.method,
          path: req.url,
          headers,
          agent: false,
        })

        upReq.on('upgrade', (upRes, upstreamSocket, upHead) => {
          upSocket = upstreamSocket
          if (closed) {
            upstreamSocket.destroy()
            return
          }
          if (upHead && upHead.length > 0) upstreamSocket.unshift(upHead)
          const lines = ['HTTP/1.1 101 Switching Protocols']
          for (let index = 0; index < upRes.rawHeaders.length; index += 2) {
            lines.push(`${upRes.rawHeaders[index]}: ${upRes.rawHeaders[index + 1]}`)
          }
          try {
            socket.write(lines.join('\r\n') + '\r\n\r\n')
            if (head && head.length > 0) upstreamSocket.write(head)
            upstreamSocket.pipe(socket)
            socket.pipe(upstreamSocket)
          } catch (error) {
            log(`upgrade pipe error: ${error instanceof Error ? error.message : String(error)}`)
            closeBoth()
            return
          }
          upstreamSocket.on('error', closeBoth)
          upstreamSocket.on('close', closeBoth)
        })

        upReq.on('response', (upRes) => {
          // Upstream declined the upgrade: relay its answer and close.
          const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || ''}`.trimEnd()]
          for (let index = 0; index < upRes.rawHeaders.length; index += 2) {
            const name = upRes.rawHeaders[index]
            if (HOP_BY_HOP.has(String(name).toLowerCase())) continue
            lines.push(`${name}: ${upRes.rawHeaders[index + 1]}`)
          }
          try {
            socket.write(lines.join('\r\n') + '\r\n\r\n')
          } catch {
            // client already gone
          }
          upRes.pipe(socket)
          upRes.on('end', () => closeBoth())
        })

        upReq.on('error', (error) => {
          log(`upgrade upstream error: ${error.code || error.message}`)
          try {
            socket.write('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
          } catch {
            // client already gone
          }
          closeBoth()
        })

        upReq.setTimeout(45_000, () => upReq.destroy(new Error('upstream upgrade timeout')))
        // A GET upgrade request has no body; without end() it is never flushed.
        upReq.end()
      },
      (error) => {
        log(`upgrade credential unavailable: ${error instanceof Error ? error.message : String(error)}`)
        try {
          socket.write('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
        } catch {
          // client already gone
        }
        closeBoth()
      },
    )
  }

  return {
    proxyHttp,
    forwardUpgrade,
    authority,
    targetOrigin,
    dispose() {
      // Agent#destroy only clears the active socket pools in current Node
      // releases; idle keep-alive sockets must be destroyed explicitly or the
      // upstream server keeps the connection open after the gateway stops.
      for (const socketList of Object.values(agent.freeSockets)) {
        for (const socket of socketList) socket.destroy()
      }
      agent.destroy()
    },
  }
}
