# 2.11.0

_2026-10-12_

## English

### New

- One-command install with no questions: the installer now picks sensible defaults for everything, and automatically moves to the next free port when the default one is taken.
- Joining a mesh through any one relay now sets the new machine up for every relay in the mesh.

### Improvements

- Running the installer on a machine that already has VibeTerm now stops with a clear hint to run `vibeterm upgrade`, instead of offering to overwrite the existing setup.
- With several relays, connection details and `vibeterm relay list` show each relay's own tenant ID.

### Fixes

- Fixed "Connect more devices" showing a relay address together with a tenant ID from a different relay, which made `vibeterm relay join` fail on the new machine. The relay address, tenant ID and join code now always refer to the same relay.
- Fixed fresh installs failing at the checksum step on Debian 12 and Ubuntu 22.04.

---

## 中文

### 新增

- 一条命令完成安装，全程无需回答任何问题：安装程序自动采用合适的默认值，默认端口被占用时自动改用下一个可用端口。
- 经任意一台中继加入后，新机器会自动配置好互联网络里的全部中继。

### 改进

- 在已安装 VibeTerm 的机器上再次运行安装程序时，会直接提示改用 `vibeterm upgrade`，不再询问是否覆盖现有安装。
- 存在多台中继时，连接详情与 `vibeterm relay list` 会显示每台中继各自的租户编号。

### 修复

- 修复「接入更多设备」把一台中继的地址与另一台中继的租户编号拼在一起，导致新机器执行 `vibeterm relay join` 失败的问题；现在中继地址、租户编号与加入码始终指向同一台中继。
- 修复 Debian 12、Ubuntu 22.04 上全新安装在校验环节失败的问题。
