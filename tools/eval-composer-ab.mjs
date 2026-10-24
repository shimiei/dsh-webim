// Compares the composer position with and without the mobile layer, inside a
// real conversation, to tell an app quirk from something this layer caused.
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  document.querySelector('.webim-drawer-btn')?.click()
  await wait(900)
  const rows = [...document.querySelectorAll('[class*="sessionRow"]')]
  const row = rows.find((el) => /远程接入插件设计/.test(el.textContent || '')) || rows[0]
  row?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  row?.click()
  await wait(2600)

  const seat = () => {
    const el = document.querySelector('[class*="composerSeat"], [class*="composer"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    const chain = []
    let node = el.parentElement
    while (node && chain.length < 6) {
      const style = getComputedStyle(node)
      const box = node.getBoundingClientRect()
      chain.push({
        cls: String(node.className).slice(0, 26),
        h: Math.round(box.height),
        top: Math.round(box.top),
        pos: style.position,
        ovf: style.overflowY,
        scrollTop: node.scrollTop,
      })
      node = node.parentElement
    }
    return { y: Math.round(r.top), h: Math.round(r.height), chain }
  }

  const withMobile = seat()
  document.documentElement.classList.remove('webim-mobile')
  await wait(1200)
  const without = seat()
  document.documentElement.classList.add('webim-mobile')
  await wait(800)
  return JSON.stringify({ withMobile, without })
})()
