(() => {
  const out = []
  for (const el of document.querySelectorAll('*')) {
    const rect = el.getBoundingClientRect()
    if (rect.top > 70 || rect.width === 0 || rect.height === 0) continue
    if (rect.left < 300) continue
    out.push({
      tag: el.tagName.toLowerCase(),
      cls: typeof el.className === 'string' ? el.className.slice(0, 46) : '',
      role: el.getAttribute('role') || '',
      aria: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    })
  }
  return JSON.stringify(out.slice(0, 40))
})()
