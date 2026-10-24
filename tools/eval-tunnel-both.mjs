// Turns on 「同时列出公网直连地址」 inside tunnel mode and checks that the panel now
// offers both addresses (and the public field) without leaving tunnel mode.
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
      mode: [...el.querySelectorAll('.wb-seg-item')].find((b) => b.classList.contains('on'))?.textContent.trim(),
      publicField: Boolean(el.querySelector('#wb-public-url')),
      cards: [...el.querySelectorAll('.wb-entry')].map((c) => ({
        label: c.querySelector('.wb-entry-label')?.textContent.trim(),
        target: c.classList.contains('is-target'),
      })),
      alsoPublic: (() => {
        const tg = [...el.querySelectorAll('.wb-tg')].find((x) => /同时列出公网/.test(x.textContent || ''))
        return { on: tg?.classList.contains('on') === true, checked: tg?.querySelector('input')?.checked === true }
      })(),
    }
  }

  const before = snap()
  const toggle = [...document.querySelectorAll('.wb-tg')].find((x) => /同时列出公网/.test(x.textContent || ''))
  toggle?.querySelector('input')?.click()
  await wait(3500)
  const after = snap()
  return JSON.stringify({ before, after })
})()
