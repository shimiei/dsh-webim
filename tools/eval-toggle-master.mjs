// Flips the master switch off and back on from the real Settings panel and
// reports what the panel shows in each state (the listener really closes, so this
// also proves the UI survives turning the whole entry off).
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

  const section = () => document.querySelector('.wb')
  const snapshot = () => {
    const el = section()
    if (!el) return 'MISSING'
    const master = [...el.querySelectorAll('.wb-switch')].find((row) => /总开关/.test(row.textContent || ''))
    return {
      status: (el.querySelector('.wb-status')?.textContent || '').trim().slice(0, 40),
      master: master?.querySelector('input')?.checked === true,
      qr: Boolean(el.querySelector('.wb-qrcode')),
      rows: el.querySelectorAll('.wb-row').length,
      note: (el.querySelector('.wb-note')?.textContent || '').trim().slice(0, 40),
    }
  }

  const out = { before: snapshot() }
  const clickMaster = () => {
    const master = [...section().querySelectorAll('.wb-switch')].find((row) => /总开关/.test(row.textContent || ''))
    const input = master?.querySelector('input')
    if (!input) return false
    input.click()
    return true
  }
  out.clickedOff = clickMaster()
  await wait(3500)
  out.off = snapshot()
  out.clickedOn = clickMaster()
  await wait(4500)
  out.on = snapshot()
  return JSON.stringify(out)
})()
