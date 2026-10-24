// Dumps the settings dialog subtree (4 levels) so the mobile layout fix can
// target real containers instead of guessed hashed class names.
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const account = [...document.querySelectorAll('button, [role="button"]')].find(
    (el) => el.getAttribute('aria-label') === '账号菜单',
  )
  account?.click()
  await wait(600)
  ;[...document.querySelectorAll('[role="menuitem"], [class*="_item_"]')]
    .find((el) => /^设置/u.test((el.textContent || '').trim()))
    ?.click()
  await wait(1400)
  const dialog = document.querySelector('[role="dialog"], dialog[open]')
  if (!dialog) return JSON.stringify({ ok: false })
  const rows = []
  const walk = (el, depth) => {
    if (depth > 4) return
    const r = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    rows.push({
      d: depth,
      tag: el.tagName.toLowerCase(),
      cls: String(el.className).slice(0, 40),
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      disp: style.display,
      dir: style.flexDirection,
      ovf: style.overflowX,
    })
    for (const child of el.children) walk(child, depth + 1)
  }
  walk(dialog, 0)
  return JSON.stringify({ ok: true, rows: rows.slice(0, 60) })
})()
