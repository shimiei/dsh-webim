// Finds any control that plausibly opens DSH settings, including ones inside
// the account menu, so the settings dialog can be reached without guessing.
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const hits = []
  for (const el of document.querySelectorAll('button, a, [role="button"], [role="menuitem"]')) {
    const text = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.textContent || ''}`
    if (!/设置|setting|偏好|preference|齿轮/iu.test(text)) continue
    const r = el.getBoundingClientRect()
    hits.push({
      text: (el.textContent || '').trim().slice(0, 16),
      aria: el.getAttribute('aria-label') || '',
      cls: String(el.className).slice(0, 30),
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    })
  }
  // Open the account menu, which is where DSH keeps the settings entry.
  const account = [...document.querySelectorAll('button, [role="button"]')].find(
    (el) => el.getAttribute('aria-label') === '账号菜单',
  )
  account?.click()
  await wait(700)
  const menu = [...document.querySelectorAll('[role="menuitem"], [class*="menu"] button, [class*="Menu"] button')].map((el) => ({
    text: (el.textContent || '').trim().slice(0, 20),
    aria: el.getAttribute('aria-label') || '',
    cls: String(el.className).slice(0, 26),
  }))
  return JSON.stringify({ before: hits.slice(0, 12), menu: menu.slice(0, 20) })
})()
