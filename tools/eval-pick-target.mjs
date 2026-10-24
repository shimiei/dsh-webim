// Clicks the entry card whose label matches `want` (from the URL hash) so the
// stored QR target can be set back to a sane default from a probe run.
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

  const want = new URLSearchParams(location.hash.replace(/^#/u, '')).get('pick') || '公网地址'
  const card = [...document.querySelectorAll('.wb-entry')]
    .find((el) => (el.querySelector('.wb-entry-label')?.textContent || '').trim() === want)
  card?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await wait(1800)
  const section = document.querySelector('.wb')
  return JSON.stringify({
    want,
    picked: [...section.querySelectorAll('.wb-entry')].map((el) => ({
      label: el.querySelector('.wb-entry-label')?.textContent.trim(),
      target: el.classList.contains('is-target'),
    })),
    caption: section.querySelector('.wb-qr-caption')?.textContent.trim(),
    err: (section.querySelector('.wb-err')?.textContent || '').trim().slice(0, 60),
  })
})()
