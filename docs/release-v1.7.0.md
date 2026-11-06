## 手机侧边栏跟上了宿主

DSH 0.2.x 把手机抽屉收进了宿主自己做：页面 frame 上挂 `data-sidebar-drawer`，折叠时写 `data-sidebar-collapsed`，再用一条 `.frame[data-sidebar-drawer][data-sidebar-collapsed] .sidebarCol { transform: translate(-100%) }` 把侧边栏推出屏幕。

那条规则的选择器权重压过任何按类名写的样式，所以 webim 自带的抽屉点 ☰ 只会给自己加个类，侧边栏一直停在屏幕外——**点不动，也呼不出来**。

### 改法

- 检测到 `data-sidebar-drawer` 时，☰ 直接点宿主自己的侧边栏开关，动画、遮罩、点会话自动收起、边缘滑动全部归宿主；
- 没有这个属性的旧版照旧用 webim 自带的抽屉，但样式收在 `webim-own-drawer` 标记下，并给 `transform` 加 `!important`，两边不会互相抢；
- 新增 `tests/mobile-drawer.test.mjs` 守住这两条不变量。

### 实测

390px 视口经网关打开：点 ☰ 侧边栏 x 从 −280 变 0；再点收起回 −280；点一条会话自动收起。桌面宽度不受影响（标记只在手机布局下加）。

### 测试

`node --test tests/*.test.mjs` → **114 pass**。
