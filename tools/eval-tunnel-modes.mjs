// Walks 公网直连 → Cloudflare隧道 on the live panel and reports the panel plus
// the persisted switches after each step. Verifies that the tunnel no longer
// forces the public address on, and that starting shows progress instead of
// freezing.
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ;[...document.querySelectorAll('button, [role="button"]')]
    .find((el) => el.getAttribute('aria-label') === '账号菜单')
    ?.click()
  await wait(700)
  ;[...document.querySelectorAll('[role="menuitem"], [class*="_item_"]')]
    .find((el) => /^设置/u.test((el.textContent || '').trim()))
    ?.click()
  await wait(1600)
  ;[...document.querySelectorAll('[role="dialog"] nav button, dialog[open] nav button')]
    .find((el) => /远程接入/u.test(el.textContent || ''))
    ?.click()
  await wait(1800)

  const snap = () => {
    const el = document.querySelector('.wb')
    if (!el) return { missing: true }
    const box = el.querySelector('.wb-tunnel')
    return {
      active: [...el.querySelectorAll('.wb-seg-item')].find((b) => b.classList.contains('on'))?.textContent.trim(),
      spinner: Boolean(el.querySelector('.wb-spin')),
      state: box?.querySelector('.wb-tunnel-state')?.textContent.trim(),
      timer: box?.querySelector('.wb-meta')?.textContent.trim(),
      url: box?.querySelector('code')?.textContent.trim(),
      err: (box?.querySelector('.wb-err')?.textContent || '').slice(0, 80),
      publicField: Boolean(el.querySelector('#wb-public-url')),
      cards: [...el.querySelectorAll('.wb-entry')].map((c) => c.querySelector('.wb-entry-label')?.textContent.trim()),
    }
  }
  const click = (pattern) => {
    ;[...document.querySelectorAll('.wb-seg-item')].find((b) => pattern.test(b.textContent || ''))?.click()
  }

  const out = { start: snap() }

  click(/^公网直连$/u)
  await wait(4000)
  out.publicMode = snap()

  click(/^Cloudflare/u)
  const frames = []
  for (let i = 0; i < 25; i += 1) {
    await wait(1000)
    const frame = snap()
    frames.push(frame)
    if (frame.url || frame.err) break
  }
  out.tunnelModeEarly = frames.slice(0, 3)
  out.tunnelModeFinal = snap()
  return JSON.stringify(out)
})()
