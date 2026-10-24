// Minimal probe: open settings, open the remote-access section, return the
// markup of the plugin section (no retries, short waits).
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
  await wait(1600)
  const section = document.querySelector('.wb')
  if (!section) return 'MISSING'
  const qr = section.querySelector('.wb-qr')
  return JSON.stringify({
    qrWidth: qr ? Math.round(qr.getBoundingClientRect().width) : null,
    qrHtml: qr ? qr.outerHTML.slice(0, 700) : null,
    mainHtml: (section.querySelector('.wb-main') || {}).outerHTML?.slice(0, 300) || null,
  })
})()
