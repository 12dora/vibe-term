# 1.1.20

_2026-09-03_

## English

### Fixes

- Signing in from this machine or a LAN address (for example `http://127.0.0.1:9883` or `http://192.168.x.x:9883`) no longer gets stuck on the passkey check. Passkeys cannot be registered on IP addresses, so password sign-ins whose source is the local machine, a private network or a carrier-NAT range skip the second step; the hub and every other node you reach through that entry follow the same decision. Sign-ins from the public internet still require the passkey. If a reverse proxy sits in front of tmex, keep "trust proxy headers" on and the proxy on the same machine or LAN, otherwise the exemption stays off.
- Node management now tells you when the hub rejected the sign-in (with the reason code) instead of reporting the hub as unreachable.
- Leaving the mesh also clears the locally remembered hub list, so a later join to a different hub does not dial the old one.
- Forwarded requests to another node's sign-in options and sign-in mode no longer fail with "missing auth".

### Improvements

- Local machine card: the "join address" line is gone. It only showed the address written down when this node first joined, which is not the current hub after a primary/standby switch; "Current hub" and the hub list already show where this node is attached.
- Passkey wording on the sign-in page and in Account security now explains the local/LAN rule.

---

## 中文

### 修复

- 从本机或局域网地址（如 `http://127.0.0.1:9883`、`http://192.168.x.x:9883`）登录不再卡在通行密钥验证。IP 地址无法注册通行密钥，因此来源为本机、内网或运营商 NAT 网段的密码登录跳过二次验证；经该入口访问的 Hub 与其它节点沿用同一判定。来自公网的登录仍需通行密钥。若 tmex 前面有反向代理，请保持「信任代理头」开启并让代理位于本机或局域网内，否则不豁免。
- 节点管理会明确提示「Hub 拒绝了本次登录（错误码）」，不再一律显示为 Hub 不可达。
- 退出多节点互联时同时清空本地记住的 Hub 列表，之后加入另一个 Hub 不会再拨旧地址。
- 经入口转发到其它节点的登录选项与登录模式请求不再报「missing auth」。

### 改进

- 本机卡片去掉「加入地址」一行：它只是本节点首次加入时记下的地址，主备切换后并不是当前 Hub；「当前 Hub」与 Hub 列表已经表明挂靠位置。
- 登录页与账号安全面板的通行密钥文案补充了本机 / 局域网规则。
