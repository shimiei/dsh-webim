// Switches to Cloudflare隧道 mode, then samples the panel every second while the
// tunnel comes up, so the loading state and the final URL can be verified.
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
    const tunnelBox = el.querySelector('.wb-tunnel')
    return {
      active: [...el.querySelectorAll('.wb-seg-item')].find((b) => b.classList.contains('on'))?.textContent.trim(),
      spinner: Boolean(el.querySelector('.wb-spin')),
      state: tunnelBox?.querySelector('.wb-tunnel-state')?.textContent.trim(),
      timer: tunnelBox?.querySelector('.wb-meta')?.textContent.trim(),
      url: tunnelBox?.querySelector('code')?.textContent.trim(),
      err: (tunnelBox?.querySelector('.wb-err')?.textContent || '').slice(0, 90),
      hasPublicField: Boolean(el.querySelector('#wb-public-url')),
      cards: [...el.querySelectorAll('.wb-entry')].map((c) => c.querySelector('.wb-entry-label')?.textContent.trim()),
      alsoPublic: Boolean([...el.querySelectorAll('.wb-tg')].find((x) => /同时列出公网/.test(x.textContent || ''))),
    }
  }

  const samples = []
  ;[...document.querySelectorAll('.wb-seg-item')].find((b) => /Cloudflare/.test(b.textContent || ''))?.click()
  for (let i = 0; i < 22; i += 1) {
    await wait(1000)
    samples.push(snap())
    const last = samples[samples.length - 1]
    if (last.url || last.err) break
  }
  return JSON.stringify({ samples: samples.filter((s, i) => i === 0 || i === 1 || i === 2 || i === samples.length - 1), final: snap() })
})()
