// Opens the collapsed "more options" block and reports what it reveals, so the
// advanced feature switches can be verified on a phone-width viewport.
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
  await wait(1800)

  const fold = document.querySelector('.wb-fold')
  const closed = { open: fold.open, h: Math.round(fold.getBoundingClientRect().height) }
  fold.querySelector('summary')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await wait(400)
  const switches = [...fold.querySelectorAll('.wb-switch')].map((el) => ({
    label: el.querySelector('.wb-switch-label')?.textContent.trim(),
    checked: el.querySelector('input')?.checked,
    inputH: Math.round(el.querySelector('input').getBoundingClientRect().height),
    inputW: Math.round(el.querySelector('input').getBoundingClientRect().width),
  }))
  return JSON.stringify({
    closed,
    open: { open: fold.open, h: Math.round(fold.getBoundingClientRect().height) },
    summary: fold.querySelector('summary')?.textContent.trim(),
    switches,
    resetButton: [...fold.querySelectorAll('button')].map((b) => b.textContent.trim()),
    docScrollW: document.documentElement.scrollWidth,
    viewportW: window.innerWidth,
  })
})()
