(() => {
  const out = []
  for (const el of document.querySelectorAll('[aria-label], [title], [data-testid]')) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    out.push([
      el.tagName.toLowerCase(),
      (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 34),
      `aL=${el.getAttribute('aria-label') || ''}`,
      `t=${el.getAttribute('title') || ''}`,
      `d=${el.getAttribute('data-testid') || ''}`,
      `@${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
    ].join(' | '))
    if (out.length > 60) break
  }
  return out.join('\n')
})()
