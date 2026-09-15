# 2.7.1

_2026-09-16_

## English

### Fixes

- Relay connections behind a local proxy (mihomo / Surge / Clash TUN with fake-IP): when the system resolver hands back a fake IP for a relay address and the connection cannot be established, VibeTerm now re-resolves the name over DNS-over-HTTPS and redials the real address directly, keeping the certificate check on the original host name. The first attempt through the proxy gets a short budget so the redial happens within a few seconds instead of after the full connect timeout; once the direct path works it is preferred for a minute. Previously such a node kept timing out against the fake IP for hours even though the relay itself was healthy (this took the Shanghai node off the Tokyo relay on 2026-09-15).

---

## 中文

### 修复

- 本地代理（mihomo / Surge / Clash 的 TUN fake-IP）后的中继连接：系统解析把中继地址解成 fake-IP 且连接失败时，VibeTerm 现在会改用 DNS-over-HTTPS 重新解析并直接拨真实地址（证书仍按原主机名校验）。经代理的首次尝试只给很短的预算，几秒内即可重拨，而不是等满整个连接超时；直连成功后一分钟内优先直连。此前这类节点会对着 fake-IP 连续超时数小时，而中继本身是健康的（2026-09-15 上海节点脱离东京中继就是这个原因）。
