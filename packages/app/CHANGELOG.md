# 1.1.13

_2026-09-02_

## English

### New

- Multiple hubs, phase 2: nodes attached to different hubs can now reach each other — the hubs forward traffic between themselves, so a failover no longer splits the mesh.
- Switch primary and standby hubs from the Nodes page: a new switch button next to the Hub tag runs the whole sequence (authorize, demote the old primary, promote the target) and survives a page refresh. If something goes wrong halfway, a recovery dialog offers retry or rollback.
- Hub authorization is now recorded with your account key and replicated to every node, instead of living in a config file on each machine. Older nodes must be upgraded before the first such record can be written; the UI lists them.
- Nodes attached to a standby hub can keep working while the primary is up: joining, renaming and removing nodes are forwarded to the primary automatically. Join codes are also copied to standby hubs, so after a failover they can still be redeemed.
- Nodes pick the nearest hub by latency (can be turned off), fail back to a recovered primary within seconds instead of a minute, and an optional automatic promotion can take over when the primary stays down (off by default).
- Node table: select multiple nodes (checkbox column with select all / none) and use the new "More" menu to upgrade, remove, or **uninstall tmex** on the selected nodes. Uninstalling stops the service and removes the program and its data on that machine, then removes it from the mesh.
- "Upgrade" from the menu includes this machine automatically, and a batch upgrade now survives a page refresh — remaining nodes continue in order and one summary appears at the end.

### Improvements

- Remote Access now shows the real tunnel state: a new connector line reports how many edge connections cloudflared holds, a "no edge connections" warning appears when the process is alive but the tunnel is down, and the log view works for tunnels managed outside tmex. The connectivity check no longer reports success when Cloudflare Access intercepted the request before it reached this machine.
- Hub chips show why the last connection attempt failed and the measured latency; the tag for this machine now reads "Current".
- The Devices & Files and Remote Access tabs in Settings swapped places.

### Fixes

- Removing the last access protection while the tunnel is temporarily down now still requires explicit confirmation.
- Secrets are scrubbed more thoroughly from tunnel logs shown in the UI.

---

## 中文

### 新增

- 多 Hub 第二阶段：挂在不同 Hub 上的节点现在可以互访——Hub 之间会互相转发流量，故障切换不再把网络割裂。
- 节点页可直接切换主备 Hub：主 / 备标签旁新增切换按钮，自动完成授权、降原主、升目标的完整流程，刷新页面后可续跑；中途失败会弹出恢复框，可重试或回滚。
- Hub 授权改为用账户密钥签名并同步到所有节点，不再依赖各机器上的配置文件。写入首条授权前须先升级所有旧节点，界面会列出未升级的节点。
- 主 Hub 在线时，挂在备 Hub 上的节点照常可用：加入、重命名、移除等操作会自动转发到主 Hub；加入码也会复制到备 Hub，故障切换后仍可兑换。
- 节点按延迟就近挂载 Hub（可关闭）；主 Hub 恢复后数秒内切回（原来约一分钟）；可选的自动接管在主 Hub 长时间离线时自动升主（默认关闭）。
- 节点表支持多选（勾选列 + 全选/全不选），新的「更多」菜单可对选中节点批量升级、移除节点或**卸载 tmex**。卸载会停止该机器上的服务、删除程序与数据，并将其移出多节点互联。
- 菜单中的「升级」自动包含本机；批量升级在刷新页面后会继续按顺序执行，结束时只弹一条汇总。

### 改进

- 远程访问页显示隧道真实状态：新增连接器一行展示 cloudflared 的边缘连接数；进程在而隧道断时显示「无连接」警示；外部托管的 cloudflared 也能查看日志。「检查连通性」不再把被 Cloudflare Access 拦截当作通过。
- Hub 徽标可查看最近一次连接失败原因与延迟；本机标签改为「当前」。
- 设置页「设备与文件」与「远程访问」两个标签互换位置。

### 修复

- 隧道暂时断连时移除最后一道访问保护，仍须显式确认。
- 界面展示的隧道日志会更彻底地隐去敏感信息。
