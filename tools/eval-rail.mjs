(async () => {
  const button = document.querySelector('.webim-drawer-btn')
  if (button) button.click()
  await new Promise((resolve) => setTimeout(resolve, 600))
  const root = document.querySelector('[class*="wtg9ga_root"]')
  if (!root) return 'no rail'
  const out = []
  const walk = (el, depth) => {
    if (depth > 6 || out.length > 60) return
    const style = getComputedStyle(el)
    const text = (el.children.length === 0 ? (el.textContent || '').trim() : '').slice(0, 16)
    if (text) {
      out.push([
        depth,
        el.tagName.toLowerCase(),
        (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 42),
        text,
        style.display,
        style.opacity,
        Math.round(el.getBoundingClientRect().width),
      ].join(' | '))
    }
    for (const child of el.children) walk(child, depth + 1)
  }
  walk(root, 0)
  return `${root.className}\n${out.join('\n')}`
})()
