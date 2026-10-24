// Exercises the new controls: pick a different QR target, switch to LAN-only,
// then back to a public mode. Reports what the panel shows at each step.
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  window.confirm = () => true
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
  await wait(2000)

  const section = () => document.querySelector('.wb')
  const probe = () => {
    const el = section()
    if (!el) return 'MISSING'
    return {
      mode: [...el.querySelectorAll('.wb-seg-item')].find((b) => b.classList.contains('on'))?.textContent.trim(),
      cards: [...el.querySelectorAll('.wb-entry')].map((c) => ({
        label: c.querySelector('.wb-entry-label')?.textContent.trim(),
        target: c.classList.contains('is-target'),
      })),
      caption: el.querySelector('.wb-qr-caption')?.textContent.trim(),
      lanToggle: (() => {
        const tg = [...el.querySelectorAll('.wb-tg')].find((t) => /局域网可访问/.test(t.textContent || ''))
        const input = tg?.querySelector('input')
        return input ? { checked: input.checked, disabled: input.disabled } : null
      })(),
      hasPublicField: Boolean(el.querySelector('#wb-public-url')),
      hasTunnelRow: Boolean([...el.querySelectorAll('.wb-field')].some((f) => /隧道|tunnel/i.test(f.textContent || ''))),
      err: (el.querySelector('.wb-err')?.textContent || '').trim().slice(0, 60),
    }
  }

  const out = { before: probe() }

  // 1. Pick the LAN card as the QR target.
  const lanCard = [...section().querySelectorAll('.wb-entry')].find((c) => /局域网/.test(c.textContent || ''))
  lanCard?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await wait(1800)
  out.afterPick = probe()

  // 2. Switch to LAN-only.
  ;[...section().querySelectorAll('.wb-seg-item')].find((b) => /仅局域网/.test(b.textContent || ''))?.click()
  await wait(2600)
  out.lanOnly = probe()

  // 3. Back to public.
  ;[...section().querySelectorAll('.wb-seg-item')].find((b) => /公网直连/.test(b.textContent || ''))?.click()
  await wait(3200)
  out.backToPublic = probe()
  return JSON.stringify(out)
})()
