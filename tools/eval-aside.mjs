// Opens the app's right-hand panel through its own toggle, so the screenshot
// shows whether the right column really slides in as a drawer on a phone.
// Used as: node tools/probe-remote.mjs 9243 <url> <shot> --eval-file tools/eval-aside.mjs
(() => {
  const trigger = [...document.querySelectorAll('button[aria-label]')].find((el) =>
    /右侧边栏|right sidebar/iu.test(el.getAttribute('aria-label') || ''),
  )
  if (!trigger) return JSON.stringify({ opened: false, reason: 'right toggle missing' })
  trigger.click()
  return JSON.stringify({ opened: true, label: trigger.getAttribute('aria-label') })
})()
