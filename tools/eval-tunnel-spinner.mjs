// Restarts the tunnel and returns while it is still coming up, so the screenshot
// taken right after this probe shows the loading state the owner asked for.
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

  const box = () => document.querySelector('.wb-tunnel')
  const snap = () => ({
    spinner: Boolean(document.querySelector('.wb-spin')),
    state: box()?.querySelector('.wb-tunnel-state')?.textContent.trim(),
    timer: box()?.querySelector('.wb-meta')?.textContent.trim(),
    url: box()?.querySelector('code')?.textContent.trim(),
    button: box()?.querySelector('button')?.textContent.trim(),
  })
  const clickBoxButton = () => box()?.querySelector('button')?.click()

  const before = snap()
  // Stop, then start again and come back while it is still opening.
  clickBoxButton()
  await wait(2500)
  const stopped = snap()
  clickBoxButton()
  await wait(1300)
  return JSON.stringify({ before, stopped, starting: snap() })
})()
