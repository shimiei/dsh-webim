// Bisects which mobile rule moves the composer out of view: injects an override
// for one candidate at a time and re-measures the composer position.
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  document.querySelector('.webim-drawer-btn')?.click()
  await wait(900)
  const rows = [...document.querySelectorAll('[class*="sessionRow"]')]
  const row = rows.find((el) => /远程接入插件设计/.test(el.textContent || '')) || rows[0]
  row?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  row?.click()
  await wait(2600)

  const seatY = () => {
    const el = document.querySelector('[class*="composerSeat"], [class*="composer"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { y: Math.round(r.top), h: Math.round(r.height) }
  }

  const probe = async (name, css) => {
    const style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
    await wait(700)
    const value = seatY()
    style.remove()
    await wait(400)
    return [name, value]
  }

  const out = { base: seatY() }
  const results = []
  results.push(await probe('frame-reset', 'html.webim-mobile [class*="_frame"], html.webim-mobile [class*="-frame"] { height: auto !important; max-height: none !important; grid-template-columns: none !important; }'))
  results.push(await probe('center-reset', 'html.webim-mobile [class*="centerCol"] { grid-column: auto !important; flex: none !important; width: auto !important; max-width: none !important; margin: 0 !important; }'))
  results.push(await probe('body-reset', 'html.webim-mobile body { overscroll-behavior-y: auto !important; } html.webim-mobile { text-size-adjust: auto !important; }'))
  results.push(await probe('composer-reset', 'html.webim-mobile [class*="composer"] { padding: 0 !important; }'))
  for (const [name, value] of results) out[name] = value
  out.after = seatY()
  return JSON.stringify(out)
})()
