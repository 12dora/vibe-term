# 2.19.0

_2026-11-20_

## English

### Features

- **Login commands for any set of nodes**: Settings → Nodes → Login command now lets you pick several nodes under "Specific nodes", not just one. You can also select rows in the node table and choose "Login command" from the bulk actions menu. The command contains exactly the nodes you pick; the current entry is no longer added automatically.

### Bug Fixes

- **Login commands work on any machine**: a login command that does not include the node the CLI connects through no longer prints "this login command does not include the entry …". Commands that only touch remote nodes (`exec`, `rsh`, `cp`, `devices ls`, `nodes ls`, `whoami`) now work through an entry you are not signed in to; node names are looked up through a node you are signed in to. Operations that run on the entry itself (for example `forward -L` or `port ls` there) still need its session and now say so plainly.
- **Paused nodes**: the node menu and bulk menu no longer offer a login command for paused nodes, matching the dialog.

---

## 中文

### 新功能

- **登录命令可选任意多台节点**：「设置 → 节点 → 登录命令」的「指定节点」改为多选；也可以在节点表中勾选若干行，从批量操作菜单生成。命令只包含所选节点，不再自动加入当前入口。

### 问题修复

- **登录命令在任何机器上都能用**：命令未包含 CLI 所用的入口节点时，不再提示「this login command does not include the entry …」。只访问远端节点的命令（`exec`、`rsh`、`cp`、`devices ls`、`nodes ls`、`whoami`）在入口未登录时也能正常使用，节点名经已登录的节点解析。在入口本机执行的操作（如在入口上 `forward -L`、`port ls`）仍需登录入口，并给出明确提示。
- **已暂停的节点**：节点菜单与批量菜单不再为已暂停的节点提供登录命令，与对话框一致。
