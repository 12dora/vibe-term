# 2.4.1

_2026-09-13_

## English

### Improvements

- Multi-node Mesh: the "This machine" card has been redesigned. Every fact now sits on one uniform label/value row, routine actions (change hub, switch to relay, add/remove/leave relay, re-enter the access password) moved into the card's ⋯ menu, and the relay-service block shrank to three lines (Public Address / TURN / Runtime) with a link to the relay console.
- Multi-node Mesh: the network block is simpler — the port list has no legend line (blocked ports are called out in words), the direct plugin row shows a single action for its current state, and domain access shows its hint inline.
- Relay Management: all metric tiles now align their values to the left.
- Latency optimisation: the three mode descriptions are shorter and clearer.

### Fixes

- Settings pages no longer show raw text keys (such as `nodes.machine.title`) when the browser language differs from the site language and Settings is opened directly.

---

## 中文

### 改进

- 多节点互联：重做「本机」卡。所有信息统一为「标签 + 值」行；更换 Hub、改为接入中继、追加 / 移除 / 离开中继、重新输入接入密码等常规操作收进卡片右上角的 ⋯ 菜单；「中继服务」压缩为「公网地址 / TURN / 运行」三行，并保留「打开中继控制台」入口。
- 多节点互联：网络区更简洁——端口列表不再有图例行（未开通的端口直接用文字标出），直连插件按当前状态只显示一个动作，域名访问的说明与开关同行。
- 中继管理：所有监控磁贴的数值统一左对齐。
- 延迟优化：三种模式的说明更简短清晰。

### 修复

- 浏览器语言与站点语言不一致时直接打开设置页，不再出现 `nodes.machine.title` 这类未翻译的原始文本。
