# 1.1.14

_2026-09-02_

## English

### New

- Remote Access: the "Access Control" step now offers three ways to protect a tunnel — none, password login, or Cloudflare Access — instead of Cloudflare Access only. Password login reuses the built-in login gate; choosing "none" while the tunnel is running asks for an explicit confirmation. The status badge now reflects the real protection ("Login Protection On", "Access Active", "No Access Protection", …) rather than always talking about Cloudflare Access.
- Login page: the "Use a passkey" button is shown whenever the page is served over HTTPS or localhost. If no passkey is registered for this address yet, clicking it explains where to add one (Settings → Account security). On plain HTTP a short note explains why passkeys are unavailable.
- Mobile PWA: when the installed app is launched, it now opens the sidebar (Terminals / Agent / Files) right away instead of landing on the device management page.

### Improvements

- Standby hubs notice a new primary within seconds after a role switch (they used to wait for the next 60 s status poll), so the whole mesh converges faster.
- Notification settings use plain wording: "Terminal Bell" options describe what they do (push / sound / throttle), and the terminal watch feature is labelled "Terminal Monitor". Webhook event names no longer carry emoji.
- The public address in Remote Access lines up with the surrounding text.
- The step title and description of "Access Control" no longer assume Cloudflare Access.

### Fixes

- Node table: the check mark in a selected row's checkbox was invisible in the dark theme.
- Files settings: the edit-directory dialog no longer shows a second "Enabled" switch; the switch on the list row is the only one.
- Remote Access: when the server asks for an exposure confirmation, the checkbox now always appears next to the action that was refused; disabling Access verification or removing the Access app on a running, login-less tunnel now asks for confirmation up front.
- Passkey login errors that happened after the passkey ceremony (for example while finishing the session) are now reported on the login page instead of leaving it stuck.

---

## 中文

### 新增

- 远程访问：「访问控制」一步现在提供三种保护方式——无、账号密码、Cloudflare Access——不再只有 Cloudflare Access。账号密码复用内置登录保护；隧道运行中选择「无」需显式确认。状态徽标按真实保护显示（「登录保护已启用」「Access 已生效」「访问保护未启用」等），不再一律显示 Access 相关文案。
- 登录页：通过 HTTPS 或 localhost 访问时始终显示「使用通行密钥」按钮；此地址尚未注册通行密钥时，点击会提示到「设置 → 账号安全」添加。普通 HTTP 下显示一行说明。
- 手机 PWA：打开已安装的应用时直接展开侧栏（终端 / 智能体 / 文件），不再停在设备管理页。

### 改进

- 主备切换后，备用 Hub 数秒内即可发现新的主 Hub（原来要等下一次 60 秒状态轮询），整个网络收敛更快。
- 通知设置文案更易懂：「终端响铃」相关选项说明各自作用（推送 / 提示音 / 频控），终端监控功能统一称「终端监控」；webhook 事件名称不再带 emoji。
- 远程访问的公网地址与上下行文字对齐。
- 「访问控制」一步的标题与说明不再默认指 Cloudflare Access。

### 修复

- 节点表：暗色主题下选中行的勾选框看不到勾号。
- 文件设置：编辑目录弹窗不再重复显示「启用」开关，只保留列表行上的开关。
- 远程访问：服务端要求暴露确认时，勾选框一定出现在被拒的那个动作旁；隧道运行且未登录时关闭 Access 校验或移除 Access 应用会提前要求确认。
- 通行密钥登录在密钥验证之后失败（如建立会话时）现在会在登录页显示错误，不再卡住。
