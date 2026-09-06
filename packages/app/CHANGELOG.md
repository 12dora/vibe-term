# 1.1.35

_2026-09-06_

## English

### New

- **Share links via the relay.** When this machine joins the mesh through a relay whose host can forward to it, the relay address is now offered as a share address, ranked above the tunnel. Addresses in the share dialog and share settings are labelled by kind (Relay · host, Tunnel · host, Hub, Custom Domain, Public IP).
- **Site URL shows all reachable addresses.** Settings → General lists the addresses this machine can be reached at (relay, tunnel, hub, public IP) with one-click fill and copy. The field is editable when connected via a relay; it is managed by the Hub only in Hub mode.
- **Default AI model is a real picker.** Settings → AI lists enabled models grouped by provider; choosing a model also sets its provider. A stored model that is no longer enabled is shown as unavailable instead of silently kept.
- **In-app dialogs for node upgrade and removal.** Browser pop-ups are gone; the upgrade confirmation lists the target nodes, and removal lets you enter an optional reason.

### Improvements

- Share settings: log retention, log size cap and share address sit on one row on wide screens.
- Node upgrade: the downloaded release package is cached once per version and reused for every node in a batch; leftover packages from earlier versions are removed on startup and before each upgrade run, packages in use are never removed, and the GitHub release lookup is shared across a batch.
- The stored site URL no longer masquerades as a custom domain when it is just the tunnel hostname.

### Fixes

- A manually entered relay address in share settings now keeps the required node prefix, so the resulting link opens.
- Cancelling a local upgrade no longer deletes a package that another node's upgrade is still downloading.
- Batch upgrade re-checks that no other upgrade started while the confirmation dialog was open.
- Clearing the model on a watch rule keeps its provider.

---

## 中文

### 新增

- **通过中继分享。** 本机经中继接入且中继主机可转发到本机时，中继地址会作为分享地址提供，并排在隧道之前。分享对话框与分享设置中的地址按种类标注（中继 · 主机、隧道 · 主机、Hub、自建域名、公网 IP）。
- **站点访问 URL 列出全部可达地址。** 「设置 → 通用」显示本机可被访问的地址（中继、隧道、Hub、公网 IP），可一键填入或复制。经中继接入时该字段可编辑；仅 Hub 模式下由 Hub 决定。
- **AI 默认模型改为真正的选择器。** 「设置 → AI」按提供商分组列出已启用的模型，选择模型即同步提供商；已停用的模型显示为不可用，不再静默保留。
- **升级与移除节点改为应用内对话框。** 不再使用浏览器弹窗；升级确认列出目标节点，移除时可填写原因。

### 改进

- 分享设置：宽屏下日志保留天数、日志上限与分享地址位于同一行。
- 节点升级：发行包按版本只下载一次并在批量升级中复用；启动时与每次升级前清理旧版本遗留包，使用中的包不会被清理；批量升级只查询一次 GitHub Release。
- 存储的站点 URL 仅为隧道域名时，不再被当作自建域名。

### 修复

- 分享设置中手动填写中继地址时保留节点前缀，生成的链接可正常打开。
- 取消本机升级不再删除其它节点仍在下载的发行包。
- 批量升级在确认对话框打开期间若有其它升级开始，确认后不再启动。
- watch 规则清空模型时保留提供商。
