// Dumps the app's own design tokens so the plugin section can match its theme
// instead of hardcoding colors that look foreign.
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

  const root = getComputedStyle(document.documentElement)
  const vars = {}
  for (const name of Array.from(root)) {
    if (!name.startsWith('--')) continue
    const value = root.getPropertyValue(name).trim()
    if (value.length > 0 && value.length < 60) vars[name] = value
  }
  const dialog = document.querySelector('[role="dialog"]')
  const nav = dialog?.querySelector('nav')
  const dialogStyle = dialog ? getComputedStyle(dialog) : null
  const navButton = nav?.querySelector('button')
  const navStyle = navButton ? getComputedStyle(navButton) : null
  const content = dialog ? [...dialog.children].find((child) => child.tagName !== 'NAV') : null
  const headingStyle = content ? getComputedStyle(content.querySelector('h1, h2, h3, div') || content) : null
  return JSON.stringify({
    vars,
    dialog: dialogStyle ? { radius: dialogStyle.borderRadius, bg: dialogStyle.backgroundColor, pad: dialogStyle.padding } : null,
    navButton: navStyle ? {
      font: navStyle.font,
      size: navStyle.fontSize,
      weight: navStyle.fontWeight,
      color: navStyle.color,
      radius: navStyle.borderRadius,
      pad: navStyle.padding,
      bg: navStyle.backgroundColor,
    } : null,
    contentFont: headingStyle ? { font: headingStyle.fontFamily, size: headingStyle.fontSize, lh: headingStyle.lineHeight } : null,
    bodyFont: getComputedStyle(document.body).fontFamily,
  })
})()
