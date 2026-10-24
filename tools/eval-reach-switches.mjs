// Verifies the new reach switches render in Settings on a phone: labels, order,
// saved state, and that nothing overflows the 390px viewport.
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
  const section = document.querySelector('.wb')
  if (!section) return 'MISSING'
  const switches = [...section.querySelectorAll('.wb-switch')].map((el) => ({
    label: (el.querySelector('.wb-switch-label')?.textContent || '').trim(),
    checked: el.querySelector('input')?.checked === true,
  }))
  const wide = []
  for (const el of section.querySelectorAll('*')) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.right > window.innerWidth + 1) wide.push({ cls: String(el.className).slice(0, 20), right: Math.round(r.right) })
  }
  const status = (section.querySelector('.wb-status')?.textContent || '').trim()
  return JSON.stringify({
    switches,
    first: switches[0]?.label,
    status: status.slice(0, 60),
    urls: section.querySelectorAll('.wb-row').length,
    hasPublicField: Boolean(section.querySelector('#wb-public-url')),
    overflow: wide.slice(0, 6),
  })
})()
