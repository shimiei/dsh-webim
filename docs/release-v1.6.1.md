## 固定隧道 + 自检

v1.6.1 补齐固定隧道的最后一环：**自检**。

### 自检做什么

面板「固定隧道」里的「自检」按钮，由本机真的去请求 `https://你的域名/__webim/ping`，把两件容易被混淆的事分开：

- 「隧道进程在跑」——cloudflared 起来了、注册上连接了；
- 「域名真能打开」——DNS、Public Hostname、回源、Access 策略全都对了。

失败按原因给不同话术：域名未解析、Cloudflare 1033 / 530、Access 拦截、回源 502、超时、连接被拒。

### Cloudflare Access 服务令牌

域名外面套了 Zero Trust Access 时，把服务令牌放进：

- `$DSH_HOME/webim/access-client-id.txt`
- `$DSH_HOME/webim/access-client-secret.txt`

自检会带 `CF-Access-Client-Id` / `CF-Access-Client-Secret` 去访问。服务令牌只解决「机器过 Access 登录页」，**不能**建 DNS 或隧道。

### 接管看门狗

热重载后新实例会接管已在跑的 cloudflared（`cloudflared.pid` 锁）。被接管的进程一死，看门狗 5 秒内自己拉起，不会再卡在「未开启」。

### 测试

`node --test tests/*.test.mjs` → **94 pass**。
