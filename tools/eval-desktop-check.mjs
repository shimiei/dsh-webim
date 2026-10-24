// Desktop sanity check: the mobile layer must not apply above the breakpoint,
// and the composer must stay pinned to the bottom of the conversation.
(() => {
  const root = document.documentElement
  const frame = document.querySelector('[class*="_frame"]')
  const seat = document.querySelector('[class*="composerSeat"], [class*="composer"]')
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { y: Math.round(r.top), h: Math.round(r.height), bottom: Math.round(r.bottom) }
  }
  return JSON.stringify({
    mobileClass: root.classList.contains('webim-mobile'),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    frame: box(frame),
    seat: box(seat),
  })
})()
