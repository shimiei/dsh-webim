## 固定隧道：用你自己的域名

v1.6.0 起，Cloudflare 隧道不再只有「临时」一种：

- **临时隧道**：`https://xxx.trycloudflare.com`，每次启动都变，但零配置。
- **固定隧道**：跑在你自己托管在 Cloudflare 的域名下，地址永远不变；填 `域名 + 连接令牌` 即可。

面板位置：设置 → 远程接入 → 对外入口 → Cloudflare 隧道 → 临时隧道 / 固定隧道。

### 配置

1. Zero Trust → Networks → Tunnels → 选定隧道 → 复制连接令牌；
2. 同一隧道下加 **Public Hostname**：`dsh.你的域名.com` → `HTTP` → `127.0.0.1:3081`（顺带建 CNAME）；
3. 面板切到「固定隧道」，填域名、粘贴令牌、保存。

令牌单独写到 `$DSH_HOME/webim/tunnel-token.txt`（0600），不进配置、不进日志、`status()` 只回 `hasToken`。

### 可靠性

- 进程异常退出：2s → 4s → 8s → … → 30s 退避重连，最多 5 次；
- 令牌被 Cloudflare 拒绝（`Tunnel not found` / `Unauthorized`）：立刻停止重连，把原因写在面板上；
- `cloudflared.pid` 锁：宿主热重载后，新实例直接接管已在跑的进程，不再叠出第二条隧道。

### 测试

`node --test tests/*.test.mjs` → **92 pass**（新增：固定域名归一、令牌落盘与 0600、拒绝令牌不重连、单实例接管与失效锁忽略）。
