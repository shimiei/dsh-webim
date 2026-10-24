// Opens DSH settings on a phone-sized viewport and reports the dialog geometry
// plus our own remote-access section, so the broken layout is measurable.
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const account = [...document.querySelectorAll('button, [role="button"]')].find(
    (el) => el.getAttribute('aria-label') === '账号菜单',
  )
  account?.click()
  await wait(600)
  const entry = [...document.querySelectorAll('[role="menuitem"], [class*="_item_"]')].find((el) =>
    /^设置/u.test((el.textContent || '').trim()),
  )
  if (!entry) return JSON.stringify({ ok: false, reason: 'settings item missing' })
  entry.click()
  await wait(1500)
  const box = (el) => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const dialog = document.querySelector('[role="dialog"], dialog[open]')
  const panel = dialog ? dialog.firstElementChild || dialog : null
  const nav = dialog ? [...dialog.querySelectorAll('button, [role="tab"], [role="menuitem"]')].slice(0, 12) : []
  return JSON.stringify({
    ok: true,
    dialog: dialog ? { cls: String(dialog.className).slice(0, 36), ...box(dialog) } : null,
    panel: panel ? { cls: String(panel.className).slice(0, 36), ...box(panel) } : null,
    nav: nav.map((el) => ({ text: (el.textContent || '').trim().slice(0, 14), ...box(el) })),
    docScrollW: document.documentElement.scrollWidth,
    docScrollH: document.documentElement.scrollHeight,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  })
})()
