# 0.16.2

_2026-07-04_

## English

### New

- Agent panel: new "Allow control characters" toggle to control whether the Agent can send terminal control sequences to a pane.
- Pane title bar now shows an Agent status emoji when an Agent is running on that pane, so you can spot active Agents at a glance.
- Tool call cards in the Agent panel are now collapsed to a single line; click a card to open the full details in a dialog.

### Improvements

- Bell notifications redesigned: alert sources are clearer, and delivery across Telegram, webhook, and browser push is more reliable.

### Fixes

- Closing a device now automatically stops any Agent sessions tied to it, so sessions no longer keep running in the background after a device is gone.

---

## 中文

### 新增

- Agent 面板新增「允许控制字符」开关，可控制 Agent 是否向终端窗格发送控制序列。
- 窗格标题栏在 Agent 运行时会显示状态 emoji，一眼即可看出哪个窗格有 Agent 在工作。
- Agent 面板的工具调用卡片改为单行摘要，点击后在弹窗中查看完整详情。

### 改进

- 通知系统重新设计：告警来源更清晰，Telegram、webhook、浏览器推送的投递更可靠。

### 修复

- 关闭设备时会自动停止该设备上运行的 Agent 会话，不再在设备离线后遗留孤立会话。