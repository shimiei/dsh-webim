// Diagnoses what the Settings panel does after the master switch is clicked:
// captures the section text, error node and input disabled state over time.
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const errors = []
  window.addEventListener('error', (event) => errors.push(String(event.message).slice(0, 120)))
  const originalError = console.error
  console.error = (...args) => {
    errors.push(args.map((value) => String(value).slice(0, 120)).join(' '))
    originalError(...args)
  }

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
    const rows = [...el.querySelectorAll('.wb-switch')]
    const master = rows.find((row) => /总开关/.test(row.textContent || ''))
    const inputs = [...el.querySelectorAll('.wb-switch input')]
    return {
      status: (el.querySelector('.wb-status')?.textContent || '').trim().slice(0, 32),
      masterChecked: master?.querySelector('input')?.checked,
      disabledInputs: inputs.filter((input) => input.disabled).length,
      qr: Boolean(el.querySelector('.wb-qrcode')),
      rows: el.querySelectorAll('.wb-row').length,
      err: (el.querySelector('.wb-err')?.textContent || '').trim().slice(0, 120),
      ok: (el.querySelector('.wb-ok')?.textContent || '').trim().slice(0, 60),
    }
  }

  const out = { before: probe() }
  const masterInput = () => {
    const master = [...section().querySelectorAll('.wb-switch')].find((row) => /总开关/.test(row.textContent || ''))
    return master?.querySelector('input')
  }
  masterInput()?.click()
  await wait(1200)
  out.after1s = probe()
  await wait(3000)
  out.after4s = probe()
  out.errors = errors.slice(0, 5)
  return JSON.stringify(out)
})()
