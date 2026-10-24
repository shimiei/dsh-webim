// Finds the injected rule that pushes the composer out of view by disabling
// halves of the mobile stylesheet and binary searching for the culprit.
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
  if (!sheet) return 'NO-SHEET'
  const rules = [...sheet.cssRules]
  const seatY = () => {
    const el = document.querySelector('[class*="composerSeat"], [class*="composer"]')
    return el ? Math.round(el.getBoundingClientRect().top) : null
  }
  const base = seatY()

  // Park a rule by pointing its selector at nothing; restore with the original.
  const park = (indices) => {
    for (const i of indices) {
      const rule = rules[i]
      if (!rule || !rule.selectorText) continue
      if (!rule.__orig) rule.__orig = rule.selectorText
      rule.selectorText = `:not(*)`
    }
  }
  const restore = () => {
    for (const rule of rules) {
      if (rule.__orig) rule.selectorText = rule.__orig
    }
  }

  sheet.disabled = true
  await wait(800)
  const allOff = seatY()
  sheet.disabled = false
  await wait(600)

  let culprits = rules.map((rule, index) => (rule.selectorText ? index : -1)).filter((i) => i >= 0)
  if (allOff === null || Math.abs(allOff - base) < 60) {
    return JSON.stringify({ base, allOff, note: 'sheet not responsible', count: rules.length })
  }
  let working = [...culprits]
  for (let round = 0; round < 8 && working.length > 1; round += 1) {
    const half = working.slice(0, Math.ceil(working.length / 2))
    park(half)
    await wait(700)
    const value = seatY()
    if (value !== null && Math.abs(value - base) > 60) {
      // Parking this half fixed it: the culprit is inside this half.
      working = half
      restore()
      await wait(500)
    } else {
      working = working.slice(half.length)
      restore()
      await wait(500)
    }
  }
  return JSON.stringify({
    base,
    allOff,
    culpritIndex: working[0] ?? null,
    culprit: working[0] !== undefined ? String(rules[working[0]].cssText).slice(0, 200) : null,
    ruleCount: rules.length,
  })
})()
