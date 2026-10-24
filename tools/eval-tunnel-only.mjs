// Restores the owner's preferred shape: tunnel on, public address off, QR on the
// tunnel. Also exercises the "both → tunnel only" direction of the toggle.
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

  const snap = () => {
    const el = document.querySelector('.wb')
    return {
      publicField: Boolean(el.querySelector('#wb-public-url')),
      cards: [...el.querySelectorAll('.wb-entry')].map((c) => c.querySelector('.wb-entry-label')?.textContent.trim()),
      target: el.querySelector('.wb-entry.is-target .wb-entry-label')?.textContent.trim(),
    }
  }

  const toggle = [...document.querySelectorAll('.wb-tg')].find((x) => /同时列出公网/.test(x.textContent || ''))
  const input = toggle?.querySelector('input')
  const before = snap()
  if (input?.checked) {
    input.click()
    await wait(3500)
  }
  return JSON.stringify({ before, after: snap() })
})()
