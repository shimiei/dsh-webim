import { VERSION } from './version.js'

const SHARED_STYLE = `
:root{color-scheme:light dark;--brand:#4d6bfe;--bg:#f4f6fb;--card:#ffffff;--fg:#1b1d22;--muted:#6b7280;--border:#e3e6ee;--err:#d92d20;--errbg:#fef3f2}
@media(prefers-color-scheme:dark){:root{--bg:#101114;--card:#1a1b1f;--fg:#e8e9ec;--muted:#9aa0aa;--border:#2a2c33;--errbg:#2a1614;--err:#ff8a80}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;font:14px/1.55 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:
radial-gradient(1200px 600px at 20% -10%,rgba(77,107,254,.18),transparent 60%),
radial-gradient(900px 500px at 110% 110%,rgba(0,180,170,.12),transparent 55%),var(--bg);color:var(--fg);
display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:390px;background:var(--card);border:1px solid var(--border);border-radius:18px;
box-shadow:0 24px 70px rgba(16,24,40,.14),0 2px 6px rgba(16,24,40,.06);padding:28px 26px 20px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:20px}
.logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#4d6bfe,#2d3fd4);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:16px;letter-spacing:.5px}
.brand h1{font-size:16px;margin:0;font-weight:600}
.brand p{margin:1px 0 0;font-size:12px;color:var(--muted)}
label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px}
input[type=password]{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--border);background:transparent;color:var(--fg);font-size:15px;outline:none;transition:border-color .15s,box-shadow .15s}
input[type=password]:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(77,107,254,.16)}
button{margin-top:16px;width:100%;padding:11px 12px;border:0;border-radius:10px;background:linear-gradient(135deg,#4d6bfe,#3350e6);color:#fff;font-size:14px;font-weight:600;cursor:pointer}
button:hover{filter:brightness(1.05)}
button:active{transform:translateY(1px)}
.err{margin:0 0 14px;padding:10px 12px;border-radius:10px;background:var(--errbg);color:var(--err);font-size:12.5px;border:1px solid rgba(217,45,32,.25)}
.hint{margin:14px 0 0;font-size:11.5px;color:var(--muted);line-height:1.5}
.foot{margin-top:18px;padding-top:14px;border-top:1px solid var(--border);display:flex;justify-content:space-between;font-size:11px;color:var(--muted)}
a{color:var(--brand);text-decoration:none}
.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
`

/**
 * Entry page: password form, or a token-only notice when the password door is off.
 * @param {{error?: string, next?: string, retryAfterSeconds?: number, brand?: string, passwordForm?: boolean}} options
 */
export function renderLogin({ error = '', next = '/', retryAfterSeconds = 0, brand = 'DeepSeek Harness', passwordForm = true } = {}) {
  const errorHtml = error
    ? `<div class="err">${escapeHtml(error)}${retryAfterSeconds > 0 ? `（${retryAfterSeconds} 秒后可重试）` : ''}</div>`
    : ''
  if (!passwordForm) {
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>远程入口 · ${escapeHtml(brand)}</title>
<style>${SHARED_STYLE}</style></head>
<body>
<div class="card">
  <div class="brand">
    <div class="logo">DS</div>
    <div><h1>${escapeHtml(brand)}</h1><p>dsh-webim 远程入口 · 令牌进入</p></div>
  </div>
  ${errorHtml}
  <p class="hint" style="font-size:13px;margin:0 0 4px">口令入口已关闭，只能通过带令牌的链接进入。</p>
  <p class="hint">请打开 DSH 的「设置 → 远程接入」，扫描二维码或复制带 <span class="mono">?token=</span> 的链接；令牌可以随时刷新，刷新后旧链接立即失效。</p>
  <div class="foot"><span>dsh-webim v${VERSION}</span><span class="mono">token only</span></div>
</div>
</body></html>`
  }
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>登录 · ${escapeHtml(brand)} WebIM</title>
<style>${SHARED_STYLE}</style></head>
<body>
<form class="card" method="post" action="/__webim/login" autocomplete="off">
  <div class="brand">
    <div class="logo">DS</div>
    <div><h1>${escapeHtml(brand)}</h1><p>dsh-webim 远程入口 · 需要口令</p></div>
  </div>
  ${errorHtml}
  <label for="pw">访问口令</label>
  <input id="pw" name="password" type="password" inputmode="text" autocomplete="current-password" autofocus required placeholder="输入进入口令">
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <button type="submit">进入 Harness</button>
  <p class="hint">登录后看到的是本机正在运行的 DeepSeek Harness 同一套界面与会话；本入口只应授权给你本人。连续输错会临时锁定。也可以直接打开带令牌的链接或扫码进入。</p>
  <div class="foot"><span>dsh-webim v${VERSION}</span><span class="mono">127.0.0.1 → remote</span></div>
</form>
</body></html>`
}

/** Generic error page used for 502/403/429 and other gateway-owned failures. */
export function renderError({ title = '出错了', message = '', detail = '', status = 500 } = {}) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${status} · ${escapeHtml(title)}</title>
<style>${SHARED_STYLE}</style></head>
<body><div class="card">
  <div class="brand"><div class="logo">!</div><div><h1>${escapeHtml(title)}</h1><p>dsh-webim</p></div></div>
  <div class="err">${escapeHtml(message)}</div>
  ${detail ? `<pre class="hint mono" style="white-space:pre-wrap;word-break:break-all">${escapeHtml(detail)}</pre>` : ''}
  <p class="hint">请确认本机 DeepSeek Harness 正在运行，并稍后刷新页面。</p>
</div></body></html>`
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
