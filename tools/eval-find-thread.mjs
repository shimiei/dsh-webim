// Finds the conversation rows in the drawer (they are virtualised and their
// class names are hashes), so a real conversation can be opened in a probe.
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  document.querySelector('.webim-drawer-btn')?.click()
  await wait(800)
  const column = document.querySelector('[class*="sidebarCol"]')
  const rows = [...(column?.querySelectorAll('*') || [])]
    .filter((el) => el.children.length === 0 && /dsh-webim|Devil|DSH|AI 助手功能介绍/.test((el.textContent || '').trim()))
    .map((el) => {
      const holder = el.closest('button, a, [role="button"], [role="treeitem"], li, div[tabindex]') || el
      return {
        text: (el.textContent || '').trim().slice(0, 20),
        leaf: `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 22)}`,
        holder: `${holder.tagName.toLowerCase()}.${String(holder.className).slice(0, 30)}`,
      }
    })
  return JSON.stringify(rows.slice(0, 10))
})()
