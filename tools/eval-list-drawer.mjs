// Lists the tappable entries inside the drawer so the settings entry can be
// found by name instead of by guesswork.
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  document.querySelector('.webim-drawer-btn')?.click()
  await wait(800)
  const column = document.querySelector('[class*="sidebarCol"]')
  if (!column) return JSON.stringify({ ok: false, reason: 'no sidebar' })
  const rows = [...column.querySelectorAll('button, a, [role="button"]')].map((el) => {
    const r = el.getBoundingClientRect()
    return {
      text: (el.textContent || '').trim().slice(0, 18),
      aria: el.getAttribute('aria-label') || '',
      cls: String(el.className).slice(0, 28),
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    }
  })
  return JSON.stringify({ ok: true, rows: rows.filter((row) => row.w > 0).slice(0, 40) })
})()
