// Geometry report for the rebuilt settings section: block sizes, segment state,
// entry cards, QR plate and any overflow, at whatever viewport the probe uses.
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
  await wait(2000)

  const section = document.querySelector('.wb')
  if (!section) return 'MISSING'
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const wide = []
  for (const el of section.querySelectorAll('*')) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && (r.right > window.innerWidth + 1 || r.width > section.getBoundingClientRect().width + 1)) {
      wide.push({ cls: String(el.className).slice(0, 26), w: Math.round(r.width), right: Math.round(r.right) })
    }
  }
  return JSON.stringify({
    viewport: { w: window.innerWidth, h: window.innerHeight },
    section: box(section),
    bar: box(section.querySelector('.wb-bar')),
    seg: box(section.querySelector('.wb-seg')),
    segItems: [...section.querySelectorAll('.wb-seg-item')].map((el) => ({ text: el.textContent.trim(), on: el.classList.contains('on'), w: Math.round(el.getBoundingClientRect().width) })),
    cards: [...section.querySelectorAll('.wb-entry')].map((el) => ({
      target: el.classList.contains('is-target'),
      label: el.querySelector('.wb-entry-label')?.textContent.trim(),
      h: Math.round(el.getBoundingClientRect().height),
    })),
    qr: box(section.querySelector('.wb-qrcode')),
    qrCaption: section.querySelector('.wb-qr-caption')?.textContent.trim(),
    token: box(section.querySelector('.wb-fold')),
    overflow: wide.slice(0, 8),
    docScrollW: document.documentElement.scrollWidth,
  })
})()
