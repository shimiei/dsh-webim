// Switches the entry mode from a probe and reports the resulting panel state.
// Usage: --eval-args? none; the target mode comes from a data attribute on the URL
// hash so the same file can switch either way.
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

  const section = () => document.querySelector('.wb')
  const want = new URLSearchParams(location.hash.replace(/^#/u, '')).get('mode') || '仅局域网'
  const item = [...section().querySelectorAll('.wb-seg-item')].find((button) => (button.textContent || '').includes(want))
  item?.click()
  await wait(3200)
  return JSON.stringify({
    want,
    active: [...section().querySelectorAll('.wb-seg-item')].find((b) => b.classList.contains('on'))?.textContent.trim(),
    cards: [...section().querySelectorAll('.wb-entry')].map((c) => c.querySelector('.wb-entry-label')?.textContent.trim()),
    hasPublicField: Boolean(section().querySelector('#wb-public-url')),
    err: (section().querySelector('.wb-err')?.textContent || '').trim().slice(0, 60),
  })
})()
