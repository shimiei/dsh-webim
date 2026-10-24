// Stops a tunnel while it is still starting: the panel must settle on 「未开启」
// with no failure message (a requested stop is not a start failure).
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
  const snap = () => {
    const b = box()
    const el = document.querySelector('.wb')
    return {
      state: b?.querySelector('.wb-tunnel-state')?.textContent.trim(),
      err: (b?.querySelector('.wb-err')?.textContent || '').trim().slice(0, 80),
      url: b?.querySelector('code')?.textContent.trim(),
      cards: [...(el?.querySelectorAll('.wb-entry') || [])].map((c) => c.querySelector('.wb-entry-label')?.textContent.trim()),
      note: (el?.querySelector('.wb-msg')?.textContent || '').trim(),
    }
  }
  const btn = () => box()?.querySelector('button')

  // start → interrupt mid-flight → settle
  if (/关闭/.test(btn()?.textContent || '')) {
    btn().click()
    await wait(2500)
  }
  btn()?.click()
  await wait(700)
  const during = snap()
  btn()?.click()
  await wait(3000)
  const cancelled = snap()

  // leave it running again
  btn()?.click()
  for (let i = 0; i < 20; i += 1) {
    await wait(1000)
    if (snap().url) break
  }
  return JSON.stringify({ during, cancelled, restored: snap() })
})()
