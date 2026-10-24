// Compact overflow check for the plugin's settings section on a phone.
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
  const wide = []
  for (const el of section.querySelectorAll('*')) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.right > window.innerWidth + 1) {
      wide.push({ cls: String(el.className).slice(0, 24), w: Math.round(r.width), right: Math.round(r.right) })
    }
  }
  const sw = section.querySelectorAll('.wb-switch').length
  return JSON.stringify({
    viewportW: window.innerWidth,
    sectionW: Math.round(section.getBoundingClientRect().width),
    switches: sw,
    overflow: wide.slice(0, 8),
    docScrollW: document.documentElement.scrollWidth,
  })
})()
