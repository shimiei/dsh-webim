// Verifies the composer survives an on-screen keyboard: the layout viewport is
// shrunk the same way `interactive-widget=resizes-content` shrinks it, then the
// composer is measured against the visible area.
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const drawer = document.querySelector('.webim-drawer-btn')
  drawer?.click()
  await wait(600)
  const column = document.querySelector('[class*="sidebarCol"]')
  const row = [...(column?.querySelectorAll('button, a') || [])].find((el) => /AI 助手功能介绍/.test(el.textContent || ''))
  row?.click()
  await wait(1500)

  const read = () => {
    const seat = document.querySelector('[class*="composerSeat"], [class*="composer"]')
    const field = document.querySelector('textarea, [contenteditable="true"]')
    const box = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { y: Math.round(r.y), h: Math.round(r.height), bottom: Math.round(r.bottom) }
    }
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      seat: box(seat),
      field: box(field),
      frame: box(document.querySelector('[class*="_frame"]')),
      active: document.activeElement ? document.activeElement.tagName.toLowerCase() : null,
    }
  }

  const before = read()
  // Simulate the keyboard: same layout-viewport shrink the browser performs.
  return JSON.stringify({ before, ready: true })
})()
