# 1.1.37

_2026-09-06_

## English

### New

- **File transfer between machines.** Manage Devices → ⋯ → "File Transfer" opens a two-pane dialog: pick a machine and a file root on each side, multi-select files or folders (Shift-click for ranges) and send them to the other side. Transfers run node-to-node over the fastest available path (direct, LAN or relay), in parallel chunks with automatic resume after a dropped link; the list below shows size, speed, ETA, progress and lets you cancel. Browser uploads and downloads now use the same engine and resume instead of restarting.
- **Port mapping.** Manage Devices → ⋯ → "Port Mapping" maps a port on machine B to a local port on machine A (for example B:12345 → A:5678). Mappings persist across restarts, can be paused or deleted, and ports already in use or reserved by tmex are refused. Works in Hub and relay mode.
- **Non-standard ports.** Hub, relay and the built-in HTTPS listener can run on a high port when an ISP blocks 80/443. Setup forms and `tmex init` offer a suggested port (2053, 2083, 2087, 2096, 8443, 13443, 23443, 31443) or a custom one; typing a hub or relay address without a port makes tmex probe 443 and the built-in candidates and fill in the one that answers (web forms, `tmex relay enroll`, `tmex hub join`). The remote-access HTTPS card shows the external address including its port.
- **Relay operator limits.** Settings → Relay → ⋯ → "Relay Limits" sets the maximum number of tenants, a total bandwidth cap shared by all tenants, and fair-share scheduling so one tenant cannot starve the others. Quotas gain a per-file size limit that tenant nodes enforce on uploads, downloads and machine-to-machine transfers. Also available as `tmex relay limits` and `tmex relay quota --max-file-mb`.

### Changes

- The "Reset Layout" action on Manage Devices moved into the new ⋯ menu.
- Relay metrics show bandwidth as used / limit and tenants as count / max when limits are set.

### Fixes

- Relay quota form: the node limit now matches the server ceiling (256) and unchanged fields keep their exact values when saving.
- Remote node upgrades share the new transfer engine; behaviour is unchanged.

---

## 中文

### 新增

- **机器间文件传输。** 「管理设备 → ⋯ → 文件传输」打开双栏对话框：两侧各选一台机器与根目录，多选文件或文件夹（Shift 区间选择）后发送到另一侧。传输在节点之间直接进行（直连、局域网或中继自动选择），分片并行，链路中断后自动续传；下方列表显示大小、速度、剩余时间与进度，可随时取消。浏览器上传与下载改用同一套引擎，中断后续传而非重来。
- **端口映射。** 「管理设备 → ⋯ → 端口映射」可把 B 机端口映射到 A 机本地端口（如 B:12345 → A:5678）。映射重启后自动恢复，可暂停或删除；已占用或 tmex 保留的端口会被拒绝。Hub 与中继模式均可用。
- **非标端口。** 80/443 被运营商封锁时，Hub、中继与本机 HTTPS 监听可架设在高位端口。接入表单与 `tmex init` 提供建议端口（2053、2083、2087、2096、8443、13443、23443、31443）或自定义；输入不带端口的 Hub / 中继地址时，tmex 会探测 443 与内置候选端口并自动补全（网页表单、`tmex relay enroll`、`tmex hub join`）。远程访问的 HTTPS 卡片显示带端口的对外地址。
- **中继运营限额。** 「设置 → 中继管理 → ⋯ → 中继限额」可设置最大租户数、所有租户共享的总带宽上限，以及租户带宽公平分配（避免单一租户占满带宽）。配额新增单文件上限，由租户节点在上传、下载与机器间传输时执行。CLI 对应 `tmex relay limits` 与 `tmex relay quota --max-file-mb`。

### 变更

- 「管理设备」的「恢复默认布局」移入新的 ⋯ 菜单。
- 中继指标在设置了上限时显示带宽「已用 / 上限」与租户「数量 / 上限」。

### 修复

- 中继配额表单：节点数上限与服务端一致（256）；保存时未修改的字段保持原值。
- 节点远程升级改用新传输引擎，行为不变。
