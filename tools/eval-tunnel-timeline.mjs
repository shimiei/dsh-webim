// Restarts the tunnel and follows it to completion, printing the panel state each
// second: proves the loading state is real, the timer ticks, and the entry list
// gains the tunnel card with its URL without ever forcing the public address on.
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
    const el = document.querySelector('.wb')
    const b = box()
    return {
      state: b?.querySelector('.wb-tunnel-state')?.textContent.trim(),
      timer: b?.querySelector('.wb-meta')?.textContent.trim(),
      url: b?.querySelector('code')?.textContent.trim(),
      err: (b?.querySelector('.wb-err')?.textContent || '').slice(0, 60),
      pendingCard: Boolean(el?.querySelector('.wb-entry.is-pending')),
      cards: [...(el?.querySelectorAll('.wb-entry') || [])].map((c) => c.querySelector('.wb-entry-label')?.textContent.trim()),
      publicField: Boolean(el?.querySelector('#wb-public-url')),
      message: (document.querySelector('.wb-msg')?.textContent || '').trim(),
    }
  }

  const restart = async () => {
    const b = box()
    const btn = b?.querySelector('button')
    if (btn && /关闭/.test(btn.textContent)) {
      btn.click()
      await wait(2500)
    }
    box()?.querySelector('button')?.click()
  }

  // 1) restart and watch it come up
  await restart()
  const series = []
  for (let i = 0; i < 20; i += 1) {
    await wait(1000)
    const frame = snap()
    series.push(`${i + 1}s ${frame.state} | ${frame.timer || '-'} | pending=${frame.pendingCard} | url=${frame.url ? 'yes' : 'no'}`)
    if (frame.url || frame.err) break
  }
  const settled = snap()
  return JSON.stringify({ series, settled, text: document.querySelector('.wb')?.textContent.length })
})()
