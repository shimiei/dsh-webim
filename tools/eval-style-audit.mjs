// Audits the computed styling of the rebuilt section so the theme match can be
// checked without eyeballing: colors actually resolve, sizes and radii line up.
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ;[...document.querySelectorAll('button, [role="button"]')]
    .find((el) => el.getAttribute('aria-label') === '账号菜单')
    ?.click()
  await wait(700)
  ;[...document.querySelectorAll('[role="menuitem"], [class*="_item_"]')]
    .find((el) => /^设置/u.test((el.textContent || '').trim()))
    ?.click()
  await wait(1600)
  ;[...document.querySelectorAll('[role="dialog"] nav button, dialog[open] nav button')]
    .find((el) => /远程接入/u.test(el.textContent || ''))
    ?.click()
  await wait(2000)

  const section = document.querySelector('.wb')
  if (!section) return 'MISSING'
  const css = (el, props) => {
    if (!el) return null
    const style = getComputedStyle(el)
    const out = {}
    for (const prop of props) out[prop] = style.getPropertyValue(prop)
    return out
  }
  const target = section.querySelector('.wb-entry.is-target')
  const plain = [...section.querySelectorAll('.wb-entry')].find((el) => !el.classList.contains('is-target'))
  return JSON.stringify({
    title: css(section.querySelector('.wb-title'), ['font-size', 'font-weight']),
    sub: css(section.querySelector('.wb-sub'), ['font-size', 'color', 'opacity']),
    bar: css(section.querySelector('.wb-bar'), ['background-color', 'border-color', 'border-radius']),
    dot: css(section.querySelector('.wb-dot'), ['background-color', 'box-shadow']),
    segOn: css(section.querySelector('.wb-seg-item.on'), ['background-color', 'color', 'font-weight', 'box-shadow']),
    segOff: css(section.querySelector('.wb-seg-item:not(.on)'), ['color']),
    entryTarget: css(target, ['border-color', 'background-color', 'border-radius', 'padding']),
    entryPlain: css(plain, ['border-color', 'background-color']),
    radio: css(target?.querySelector('.wb-radio'), ['border-color', 'width', 'height']),
    url: css(section.querySelector('.wb-entry .wb-url'), ['font-family', 'font-size', 'opacity']),
    qrPlate: css(section.querySelector('.wb-qrcode'), ['width', 'height', 'border-radius', 'background-color', 'box-shadow']),
    caption: css(section.querySelector('.wb-qr-caption'), ['font-size', 'opacity']),
    tgTrack: css(section.querySelector('.wb-tg.on .wb-tg-track'), ['background-color', 'width', 'height', 'border-radius']),
    tgKnob: css(section.querySelector('.wb-tg.on .wb-tg-knob'), ['transform', 'background-color']),
    h3: css(section.querySelector('.wb-h'), ['font-size', 'letter-spacing', 'text-transform', 'opacity']),
    divider: css(section.querySelector('.wb-divider'), ['background-color', 'height']),
    btn: css(section.querySelector('.wb-btn'), ['border-radius', 'font-size', 'border-color']),
    bodyBg: css(document.querySelector('[role="dialog"]'), ['background-color']),
    accentToken: getComputedStyle(document.documentElement).getPropertyValue('--color-blue-500').trim(),
  })
})()
