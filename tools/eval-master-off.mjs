// Turns the master switch off from the remote page itself (the worst case: the
// reply cannot come back because the port closes) and checks the panel still
// reads correctly instead of showing a red transport error.
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
  await wait(1800)

  const section = () => document.querySelector('.wb')
  const probe = () => {
    const el = section()
    if (!el) return 'MISSING'
    const master = [...el.querySelectorAll('.wb-switch')].find((row) => /总开关/.test(row.textContent || ''))
    return {
      status: (el.querySelector('.wb-status')?.textContent || '').trim().slice(0, 24),
      master: master?.querySelector('input')?.checked,
      qr: Boolean(el.querySelector('.wb-qrcode')),
      rows: el.querySelectorAll('.wb-row').length,
      err: (el.querySelector('.wb-err')?.textContent || '').trim().slice(0, 80),
      note: [...el.querySelectorAll('.wb-note')].map((n) => (n.textContent || '').trim()).filter((text) => /总开关|已应用/u.test(text))[0]?.slice(0, 60) || '',
    }
  }

  const before = probe()
  const master = [...section().querySelectorAll('.wb-switch')].find((row) => /总开关/.test(row.textContent || ''))
  master?.querySelector('input')?.click()
  await wait(2500)
  const after = probe()
  return JSON.stringify({ before, after })
})()
