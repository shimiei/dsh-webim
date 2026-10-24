// Dumps the conversation shell geometry (frame → columns → scroll containers)
// so the composer can be pinned where the desktop layout keeps it.
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  document.querySelector('.webim-drawer-btn')?.click()
  await wait(900)
  const rows = [...document.querySelectorAll('[class*="sessionRow"]')]
  const row = rows.find((el) => /远程接入插件设计/.test(el.textContent || '')) || rows[0]
  row?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  row?.click()
  await wait(2500)
  const frame = document.querySelector('[class*="_frame"]')
  if (!frame) return 'NO-FRAME'
  const rows2 = []
  const walk = (el, depth) => {
    if (depth > 3) return
    const r = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    const cls = String(el.className)
    rows2.push({
      d: depth,
      tag: el.tagName.toLowerCase(),
      cls: cls.slice(0, 34),
      y: Math.round(r.y),
      h: Math.round(r.height),
      disp: style.display,
      pos: style.position,
      ovf: style.overflowY,
      gtr: style.gridTemplateRows,
      gtc: style.gridTemplateColumns,
      minH: style.minHeight,
    })
    for (const child of el.children) walk(child, depth + 1)
  }
  walk(frame, 0)
  return JSON.stringify({
    scrollY: window.scrollY,
    docScrollH: document.documentElement.scrollHeight,
    rows: rows2.slice(0, 34),
  })
})()
