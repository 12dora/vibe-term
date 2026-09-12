# 「接入更多设备」面板与远程访问向导

本文描述右侧「接入更多设备」面板（移动设备 / 服务器两条路径、候选地址排序、就地生成加入码）与远程访问向导的结构；面向改动 `apps/fe/src/components/side-panels/connect-devices/` 的开发者。

## 背景

- 新用户要能在一个入口里把手机、第二台电脑或服务器接进来，而不是去顶栏图标里找多节点互联。
- 远程访问向导的「直接连接」不能排在「安装 cloudflared → 选择方式」之后，否则看起来像必须装 cloudflared 才能直连。

## 设计

- 右侧滑出面板 `?panel=connect`（`apps/fe/src/components/side-panels/connect-devices/`），入口在侧栏底部「管理设备」左侧（`nav.connectDevices` / 短标签 `nav.connectDevicesShort`）。顶栏「多节点互联」图标与 `?panel=nodes` 移除，多节点互联只保留在设置页；设备页「+」菜单顶部新增「添加远程节点」跳 `/settings?tab=nodes`。
- 面板两个标签（Base UI Tabs + TabsContent，静态内容）：
  - 移动设备（仅控制）：iOS / Android 子标签，各四步（选择地址 → 扫码打开 → 添加到主屏幕/安装应用 → 从主屏幕打开，见下节），末尾提示局域网限制并链到远程访问设置。
  - 服务器或电脑：第 1 步选路径（经中继 / 经 Hub / SSH）。**加入**路径：② 安装 → ③ **放行端口** → ④ 起为加入步骤（准备上级 → 生成加入码 → `vibeterm hub join` 示例 → 确认加入）。**本机作为 Hub**：② 配置公网入口 → ③ 设为 Hub → ④ **放行端口** → ⑤ 邀请。**本机作为中继**：② 设为中继 → ③ **放行端口** → ④ 密码 → ⑤ enroll → ⑥ 邀请。SSH 路径不加「放行端口」。清单优先 `GET /api/local/status.portPlan`，缺字段则 `portPlanForRole` 用该路径角色的默认 live。
  - 命令块 `command-block.tsx` 复用 `copy-feedback.tsx` 的复制反馈。
- 「加入已有中继」在放行端口之后就地生成加入码（`use-create-enrollment.ts` 与节点管理页共用），随后命令与加入码/节点名称联动，再就地确认加入：证书监听 + admit 签名收敛为 `apps/fe/src/node/enrollment-engine.ts` 单例（一条轮询、全局 key-log 写互斥、签前重校验、已签记录先入未确认存储、签名者租约、面板会话 id 持久化）。
- 「本机作为 Hub / 中继」的公网入口与角色步骤由 `host-status.ts` 按隧道状态与 auth mode 推导（命名/接管/临时隧道、Hub 公开地址；本机 self/node/standalone）；「放行端口」插在设为 Hub/中继之后、邀请之前。
- 移动设备第 1 步的候选地址由 `access-addresses.ts` 排序：健康隧道 → 本机 Hub → 中继入口 → 局域网 → Tailscale → VPN → 掉线隧道 → 非回环当前地址。
  - 「Hub」只在本机自己就是 Hub（`mode.hubNodeId === mode.nodeId`）且非中继上联时出现；成员节点上 `hubPublicUrl` 是上级地址，扫出来打开的是上级界面。回环地址一律丢弃。后端 `resolveHub()` 在中继上联时直接返回空，也不再用 `http://127.0.0.1` 兜底。
  - 「中继」是 `GET /api/system/addresses` 下发的 `relayAccessUrl`（`<中继>/n/<本机 nodeId>`），复用分享侧的入口探测，探不通则不列。
  - 局域网候选由 `apps/gateway/src/system/lan-interfaces.ts` 枚举并分类：丢掉链路本地、代理 fake-IP（`198.18.0.0/15`）与容器 / 虚拟机 / 桥接网卡；CGNAT（`100.64.0.0/10`）标为「Tailscale」，其它隧道网卡上的私网地址标为「VPN」并排在物理局域网之后；默认路由所在物理网卡的地址排第一（默认路由被代理接管到 `utun` 时不加权）。绑定到具体 IPv4 时只列该地址。
- 文案在 `connectDevices.*` 三语；风格：短句、「本机」、不用「你」。
- 远程访问向导：新增顶层「连接方式」步（`ConnectionPath = 'tunnel' | 'direct'`，与 `WizardMode` 分离）。隧道分支：安装 → 隧道类型（临时/命名）→ …；直连分支只剩访问保护。已配置隧道时锁定为隧道；隧道移除后向导本地状态归零；未选/直连时不显示隧道状态卡。

## 移动设备页：选择地址 → 扫码

不让用户在手机上手输 `http://192.168.x.x:9883`。四步：

1. **选择地址**：候选来自 `use-access-addresses.ts`，用原生 radio（`input` 为 `sr-only`，圆点自绘，焦点环挂在外层 `label` 的 `has-[:focus-visible]` 上）保住分组语义、方向键切换与读屏播报。只有一条候选时不做成单选，原样摆出来。选中项由平台页上层持有（`useMobileAddressChoice`）——切 iOS / Android 会把平台页整块卸载，状态放里面会丢；选中的地址还没进列表或已消失时退回第一条。
2. **扫码打开**：`qrcode.react` 的 `QRCodeSVG` 渲染选中地址，白底衬垫是必须的（深色主题下直接画在 card 上相机识别率会掉）。命令块保留，作为扫不了码时的兜底。
3. **添加到主屏幕 / 安装应用**、4. **从主屏幕打开**：与原来一致。

`data-testid`：`connect-access-addresses`、`connect-address-<index>`（带 `data-kind`）。文案在 `connectDevices.mobile.chooseAddress.*` / `connectDevices.mobile.scan.*`。

面板本身包在面板级错误边界里、按需 chunk 走 `lazyChunk`，详见 [应用级错误边界](./app-error-boundary.md)。

## 非标端口

Hub 与中继可以架在 443 以外的高位端口（运营商封 80/443 时的常规做法）。面板里展示的加入命令带的是各自公开地址的原样端口，不需要额外处理；
用户手输地址的地方（接入向导、中继接入 / 追加 / 迁移对话框、`vibeterm hub join` / `vibeterm relay enroll`）在没写端口时会先探 443，再探内置候选端口，
探到就把地址补全成带端口的形式。角色入站口、HTTPS 候选表与部署形态见 [角色入站端口与非标 HTTPS](../operations/nonstandard-ports.md)。

## 测试

- `apps/fe` 单测覆盖面板默认标签、命令块内容、侧栏入口 href、设备菜单首项与分隔、向导两分支与锁定；e2e `devices.spec.ts`。
