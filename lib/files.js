import { createReadStream } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { isInlineType, mimeForPath, needsSandbox } from './mime.js'
import { dshHome } from './config.js'

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function formatBytes(size) {
  if (!Number.isFinite(size)) return ''
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = size / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`
}

/** Read a query parameter without treating `+` as a space (Windows paths keep it). */
function rawParam(rawQuery, name) {
  if (!rawQuery) return undefined
  for (const pair of rawQuery.split('&')) {
    const at = pair.indexOf('=')
    const key = at === -1 ? pair : pair.slice(0, at)
    if (key !== name) continue
    const value = at === -1 ? '' : pair.slice(at + 1)
    const plusSafe = value.replaceAll('+', '%2B')
    try {
      return decodeURIComponent(plusSafe)
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Enumerate drive roots (Windows) or `/` (POSIX) for the picker page. */
async function listRoots() {
  if (process.platform !== 'win32') return [{ label: '/', path: '/' }]
  const roots = []
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`
    try {
      await fsp.access(root)
      roots.push({ label: root, path: root })
    } catch {
      // drive absent
    }
  }
  return roots
}

function lower(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function isUnder(parent, child) {
  const p = lower(normalize(parent)).replace(/[\\/]+$/u, '')
  const c = lower(normalize(child))
  return c === p || c.startsWith(p + (process.platform === 'win32' ? '\\' : '/'))
}

/** Built-in deny list: never expose the gateway secret or harness credentials. */
function builtinDenied(config) {
  const home = dshHome()
  return [
    config.stateDir,
    join(home, '.credentials.yaml'),
    join(home, '.credentials.yaml.bak'),
  ]
}

function isDenied(target, config) {
  for (const denied of [...builtinDenied(config), ...config.deniedPaths]) {
    if (typeof denied !== 'string' || denied === '') continue
    if (isUnder(denied, target)) return true
  }
  return false
}

function isAllowed(target, config) {
  if (config.allowedRoots.length === 0) return true
  return config.allowedRoots.some((root) => isUnder(root, target))
}

function fsLink(targetPath, extra = '') {
  return `/__webim/fs?path=${encodeURIComponent(targetPath)}${extra}`
}

function renderListingHtml({ title, target, parent, entries, roots }) {
  const rows = []
  if (parent) {
    rows.push(`<tr><td colspan="3"><a class="up" href="${escapeHtml(fsLink(parent))}">⬆ 上一级</a></td></tr>`)
  }
  for (const entry of entries) {
    const href = fsLink(entry.path)
    rows.push(
      `<tr><td class="ico">${entry.dir ? '📁' : '📄'}</td>` +
      `<td><a href="${escapeHtml(href)}">${escapeHtml(entry.name)}${entry.dir ? '/' : ''}</a></td>` +
      `<td class="size">${entry.dir ? '目录' : escapeHtml(formatBytes(entry.size))}</td></tr>`,
    )
  }
  const rootLinks = roots
    .map((root) => `<a class="chip" href="${escapeHtml(fsLink(root.path))}">${escapeHtml(root.label)}</a>`)
    .join(' ')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · dsh-webim</title>
<style>
:root{color-scheme:light dark}
body{margin:0;font:14px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;background:#f6f7f9;color:#1c1d21}
@media(prefers-color-scheme:dark){body{background:#151517;color:#e7e8ea}.card{background:#1e1f22!important;border-color:#2c2d31!important}tr:hover{background:#26272b!important}a{color:#8fa8ff!important}.chip{background:#26272b!important;border-color:#33353a!important}}
.wrap{max-width:960px;margin:0 auto;padding:20px}
h1{font-size:15px;font-weight:600;word-break:break-all;margin:0 0 4px}
.sub{opacity:.6;font-size:12px;margin-bottom:14px}
.card{background:#fff;border:1px solid #e4e6ea;border-radius:12px;overflow:hidden}
table{width:100%;border-collapse:collapse}
td{padding:8px 12px;border-bottom:1px solid rgba(128,128,128,.14);vertical-align:middle}
tr:last-child td{border-bottom:0}
tr:hover{background:#f2f4f8}
.ico{width:28px;text-align:center}
.size{width:120px;text-align:right;opacity:.65;font-size:12px;white-space:nowrap}
a{color:#4d6bfe;text-decoration:none}
a:hover{text-decoration:underline}
.chip{display:inline-block;padding:4px 10px;margin:0 6px 6px 0;border:1px solid #dfe2e8;border-radius:999px;font-size:12px}
.up{font-size:13px}
</style></head><body><div class="wrap">
<h1>${escapeHtml(title)}</h1>
<div class="sub">${escapeHtml(target)} · ${entries.length} 项 · dsh-webim 本地文件</div>
<div style="margin-bottom:12px">${rootLinks}</div>
<div class="card"><table>${rows.join('') || '<tr><td colspan="3" style="opacity:.6">空目录</td></tr>'}</table></div>
</div></body></html>`
}

async function readDir(target) {
  const dirents = await fsp.readdir(target, { withFileTypes: true })
  dirents.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
  })
  const entries = []
  for (const dirent of dirents.slice(0, 2000)) {
    const child = join(target, dirent.name)
    let stat
    try {
      stat = await fsp.stat(child)
    } catch {
      continue
    }
    entries.push({
      name: dirent.name,
      path: child,
      dir: stat.isDirectory(),
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs),
    })
  }
  return entries
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(String(header || '').trim())
  if (!match) return undefined
  const [, rawStart, rawEnd] = match
  let start = rawStart === '' ? undefined : Number(rawStart)
  let end = rawEnd === '' ? undefined : Number(rawEnd)
  if (start === undefined && end === undefined) return undefined
  if (start === undefined) {
    start = Math.max(0, size - end)
    end = size - 1
  } else {
    if (end === undefined) end = size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    return null
  }
  return { start, end: Math.min(end, size - 1) }
}

function contentDisposition(filePath, download) {
  const name = basename(filePath)
  const fallback = name.replace(/[^\x20-\x7e]/gu, '_').replaceAll('"', "'")
  const encoded = encodeURIComponent(name).replaceAll("'", '%27')
  const kind = download ? 'attachment' : 'inline'
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

/**
 * Serve `/__webim/fs` — the remote-safe local filesystem view.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{config: object, log: (line: string) => void}} deps
 */
export async function handleFsRequest(req, res, { config, log }) {
  const rawQuery = String(req.url ?? '').split('?').slice(1).join('?')
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }

  const rawPath = rawParam(rawQuery, 'path')
  const format = rawParam(rawQuery, 'format')
  const roots = await listRoots()

  if (rawPath === undefined || rawPath === '') {
    const home = dshHome()
    res.writeHead(200, HTML_HEADERS)
    res.end(renderListingHtml({ title: '选择要浏览的位置', target: '', parent: undefined, entries: [], roots: [
      ...roots,
      ...(home ? [{ label: `DSH_HOME (${home})`, path: home }] : []),
    ] }))
    return
  }

  if (rawPath.includes('\0')) {
    res.writeHead(400, HTML_HEADERS)
    res.end('<p>非法路径</p>')
    return
  }

  let target = rawPath
  if (!isAbsolute(target)) {
    res.writeHead(400, HTML_HEADERS)
    res.end('<p>需要绝对路径，例如 C:\\Users\\… 或 D:\\data</p>')
    return
  }
  target = normalize(resolve(target))

  let real
  try {
    real = await fsp.realpath(target)
  } catch {
    res.writeHead(404, HTML_HEADERS)
    res.end('<p>路径不存在或无权读取</p>')
    return
  }

  if (isDenied(real, config) || isDenied(target, config)) {
    res.writeHead(403, HTML_HEADERS)
    res.end('<p>该路径已被 dsh-webim 禁止访问</p>')
    return
  }
  if (!isAllowed(real, config) && !isAllowed(target, config)) {
    res.writeHead(403, HTML_HEADERS)
    res.end('<p>该路径不在允许的根目录内</p>')
    return
  }

  let stat
  try {
    stat = await fsp.stat(real)
  } catch {
    res.writeHead(404, HTML_HEADERS)
    res.end('<p>路径不可访问</p>')
    return
  }

  if (stat.isDirectory()) {
    const entries = await readDir(real)
    if (format === 'json') {
      const body = JSON.stringify({ ok: true, path: real, parent: dirname(real) === real ? null : dirname(real), entries })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
      return
    }
    res.writeHead(200, HTML_HEADERS)
    res.end(renderListingHtml({
      title: basename(real) || real,
      target: real,
      parent: dirname(real) === real ? undefined : dirname(real),
      entries,
      roots,
    }))
    return
  }

  if (!stat.isFile()) {
    res.writeHead(400, HTML_HEADERS)
    res.end('<p>不是普通文件</p>')
    return
  }

  const download = rawParam(rawQuery, 'download') === '1'
  const type = mimeForPath(real)
  const headers = {
    'content-type': type,
    'cache-control': 'private, max-age=60',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
    'content-disposition': contentDisposition(real, download),
  }
  if (needsSandbox(real)) {
    headers['content-security-policy'] = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'"
  }
  if (!download && !isInlineType(real)) {
    headers['content-disposition'] = contentDisposition(real, true)
  }

  const range = parseRange(req.headers.range, stat.size)
  if (range === null) {
    res.writeHead(416, { 'content-range': `bytes */${stat.size}` })
    res.end()
    return
  }

  if (range) {
    headers['content-range'] = `bytes ${range.start}-${range.end}/${stat.size}`
    headers['content-length'] = String(range.end - range.start + 1)
    res.writeHead(206, headers)
    if (method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(real, { start: range.start, end: range.end }).pipe(res)
    return
  }

  headers['content-length'] = String(stat.size)
  res.writeHead(200, headers)
  if (method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(real).pipe(res).on('error', (error) => {
    log(`fs stream error for ${real}: ${error instanceof Error ? error.message : String(error)}`)
    res.destroy(error)
  })
}
