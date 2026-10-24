// Opens the first conversation from the drawer, then waits so the composer can
// be inspected after its focus / keyboard dance settles.
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const drawer = document.querySelector('.webim-drawer-btn')
  drawer?.click()
  await wait(700)
  const rows = [...document.querySelectorAll('[class*="sidebarCol"] button, [class*="sidebarCol"] a')]
  const target = rows.find((el) => /AI 助手功能介绍|新会话/.test(el.textContent || '')) || rows[2]
  if (!target) return JSON.stringify({ ok: false, reason: 'no session row' })
  const label = (target.textContent || '').trim().slice(0, 24)
  target.click()
  await wait(1600)
  const composer = document.querySelector('[class*="composer"], [class*="Composer"], textarea, [contenteditable="true"]')
  const editable = document.activeElement
  return JSON.stringify({
    ok: true,
    clicked: label,
    composer: composer
      ? {
          tag: composer.tagName.toLowerCase(),
          cls: String(composer.className).slice(0, 40),
          rect: (({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }))(
            composer.getBoundingClientRect(),
          ),
        }
      : null,
    active: editable ? `${editable.tagName.toLowerCase()}.${String(editable.className).slice(0, 30)}` : null,
    drawerOpen: document.documentElement.className,
  })
})()
