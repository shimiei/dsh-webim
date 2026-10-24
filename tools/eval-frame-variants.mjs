// Narrows the frame rule to the single declaration that moves the composer:
// each variant is applied alone and the composer position re-measured.
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  document.querySelector('.webim-drawer-btn')?.click()
  await wait(900)
  const rows = [...document.querySelectorAll('[class*="sessionRow"]')]
  const row = rows.find((el) => /远程接入插件设计/.test(el.textContent || '')) || rows[0]
  row?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  row?.click()
  await wait(2600)

  const sheet = [...document.styleSheets].find((s) => (s.href || '').includes('/__webim/client.css'))
  const rules = [...sheet.cssRules]
  const FRAME_INDEX = 6
  const seatY = () => {
    const el = document.querySelector('[class*="composerSeat"], [class*="composer"]')
    return el ? Math.round(el.getBoundingClientRect().top) : null
  }
  const original = rules[FRAME_INDEX].cssText
  const out = { base: seatY(), original: original.slice(0, 120) }
  const variants = {
    height: 'height: 100dvh !important; max-height: 100dvh !important;',
    width: 'width: 100% !important;',
    columns: 'grid-template-columns: minmax(0, 1fr) !important;',
    rows: 'grid-template-rows: minmax(0, 1fr) !important;',
    full: 'height: 100dvh !important; max-height: 100dvh !important; width: 100% !important; grid-template-columns: minmax(0, 1fr) !important; grid-template-rows: minmax(0, 1fr) !important; overflow: hidden !important;',
  }
  const selector =
    'html.webim-mobile [class*="_frame"]:not([class^="wb"]):not([class*=" wb-"]), html.webim-mobile [class*="-frame"]:not([class^="wb"]):not([class*=" wb-"])'
  for (const [name, body] of Object.entries(variants)) {
    rules[FRAME_INDEX].selectorText = ':not(*)'
    const style = document.createElement('style')
    style.textContent = `${selector} { ${body} }`
    document.head.appendChild(style)
    await wait(800)
    out[name] = seatY()
    style.remove()
    await wait(400)
  }
  rules[FRAME_INDEX].selectorText = selector
  await wait(500)
  out.restored = seatY()
  return JSON.stringify(out)
})()
