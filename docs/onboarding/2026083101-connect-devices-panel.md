# 「接入更多设备」面板与远程访问入口重排

## 背景

- 新用户不知道如何把手机、第二台电脑或服务器接进来；多节点互联的入口藏在顶栏图标里。
- 远程访问向导把「直接连接」排在「安装 cloudflared → 选择方式」之后，看起来像必须装 cloudflared 才能直连。

## 设计

- 右侧滑出面板 `?panel=connect`（`apps/fe/src/components/side-panels/connect-devices/`），入口在侧栏底部「管理设备」左侧（`nav.connectDevices` / 短标签 `nav.connectDevicesShort`）。顶栏「多节点互联」图标与 `?panel=nodes` 移除，多节点互联只保留在设置页；设备页「+」菜单顶部新增「添加远程节点」跳 `/settings?tab=nodes`。
- 面板两个标签（Base UI Tabs + TabsContent，静态内容）：
  - 移动设备（仅控制）：iOS / Android 子标签，各三步（打开当前地址 → 添加到主屏幕/安装应用 → 从主屏幕打开），末尾提示局域网限制并链到远程访问设置。
  - 服务器或电脑：① 安装（`INSTALL_COMMAND` 命令块 + PATH 提示）② 选择方式子标签：「加入已有中继」（准备中继 → 生成加入码 → `tmex hub join` 示例 → 确认加入）/「本机作为中继」（配置公网入口 → 设为 Hub（公开地址不可改的警示）→ 接入其他机器）。
  - 命令块 `command-block.tsx` 复用 `copy-feedback.tsx` 的复制反馈。
- 「加入已有中继」第 4 步就地生成加入码（`use-create-enrollment.ts` 与节点管理页共用），第 5 步命令与加入码/节点名称联动，第 6 步就地确认加入：证书监听 + admit 签名收敛为 `apps/fe/src/node/enrollment-engine.ts` 单例（一条轮询、全局 key-log 写互斥、签前重校验、已签记录先入未确认存储、签名者租约、面板会话 id 持久化）。
- 「本机作为中继」第 3–5 步由 `host-status.ts` 按隧道状态与 auth mode 推导（命名/接管/临时隧道、Hub 公开地址；本机 self/node/standalone）。
- 移动设备第 1 步地址由 `access-addresses.ts` 按公网 → 局域网（`GET /api/system/addresses`）→ 非回环当前地址排序。
- 文案在 `connectDevices.*` 三语；风格：短句、「本机」、不用「你」。
- 远程访问向导：新增顶层「连接方式」步（`ConnectionPath = 'tunnel' | 'direct'`，与 `WizardMode` 分离）。隧道分支：安装 → 隧道类型（临时/命名）→ …；直连分支只剩访问保护。已配置隧道时锁定为隧道；隧道移除后向导本地状态归零；未选/直连时不显示隧道状态卡。

## 验收

- `apps/fe` 单测覆盖面板默认标签、命令块内容、侧栏入口 href、设备菜单首项与分隔、向导两分支与锁定；e2e `devices.spec.ts` 已按恒定展开菜单补点选。
