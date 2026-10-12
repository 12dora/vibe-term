# 「接入更多设备」面板与远程访问向导

本文描述右侧「接入更多设备」面板（移动设备 / 服务器两条路径、候选地址排序、就地生成加入码）与远程访问向导的结构；面向改动 `apps/fe/src/components/side-panels/connect-devices/` 的开发者。

## 背景

- 新用户要能在一个入口里把手机、第二台电脑或服务器接进来，而不是去顶栏图标里找多节点互联。
- 远程访问向导的「直接连接」不能排在「安装 cloudflared → 选择方式」之后，否则看起来像必须装 cloudflared 才能直连。

## 设计

- 右侧滑出面板 `?panel=connect`（`apps/fe/src/components/side-panels/connect-devices/`），入口在侧栏底部「管理设备」左侧（`nav.connectDevices` / 短标签 `nav.connectDevicesShort`）。顶栏「多节点互联」图标与 `?panel=nodes` 移除，多节点互联只保留在设置页；设备页「+」菜单顶部新增「添加远程节点」跳 `/settings?tab=nodes`。
- 面板两个标签（Base UI Tabs + TabsContent，静态内容）：
  - 移动设备（仅控制）：iOS / Android 子标签，各四步（选择地址 → 扫码打开 → 添加到主屏幕/安装应用 → 从主屏幕打开，见下节），末尾提示局域网限制并链到远程访问设置。
  - 服务器或电脑：第 1 步选路径（经中继 / SSH）。**加入已有中继**：② 安装 → ③ **放行端口** → ④ 起为加入步骤（准备上级 → 生成加入码 → `vibeterm relay join` 示例 → 确认加入）。**本机作为中继**：② 设为中继 → ③ **放行端口** → ④ 密码 → ⑤ enroll → ⑥ 邀请。SSH 路径不加「放行端口」。清单优先 `GET /api/local/status.portPlan`，缺字段则 `portPlanForRole` 用该路径角色的默认 live。
  - 命令块 `command-block.tsx` 复用 `copy-feedback.tsx` 的复制反馈。
- 「加入已有中继」在放行端口之后就地生成加入码（`use-create-enrollment.ts` 与节点管理页共用），随后命令与加入码/节点名称联动，再就地确认加入：证书监听 + admit 签名收敛为 `apps/fe/src/node/enrollment-engine.ts` 单例（一条轮询、全局 key-log 写互斥、签前重校验、已签记录先入未确认存储、签名者租约、面板会话 id 持久化）。确认加入的两步与结果状态见下文「确认加入」一节。
- 「新机器该指向哪台中继」只有一个选择器：`apps/fe/src/node/mesh-relay.ts` 的 `relayJoinTarget`（基于 `@vibeterm/shared/relay` 的 `pickRelayJoinTarget`，主中继 → 已挂上 → priority 最小），地址与租户编号取自同一行。中继地址 / 租户编号块、`vibeterm relay join` 命令、加入码命令的预览地址都用它；`createEnrollmentOnRelay` 在该中继收下 enrollment 时把它排在 `r3` 加入码的第一条，没收下才退回第一台收下的中继。「本机作为中继」一侧不用它：`useConnectMachine` 的 `hostTenantId`（`relayHostTenantId`，按 URL origin 匹配本机中继对外地址的那一行）才与 `relayPublicUrl` 配对，本机只是别台中继的租户时它为 null，enroll 步骤保持待办。旧网关不下发逐行租户编号：密码加入命令指向 priority 最小的中继，生成的加入码可能只列已挂上的那一台，两条命令各自自洽。
- 「本机作为中继」的公网入口与角色步骤由 `host-status.ts` 按隧道状态推导（命名/接管/临时隧道）；「放行端口」插在设为中继之后、邀请之前。
- 移动设备第 1 步的候选地址由 `access-addresses.ts` 排序：健康隧道 → 中继入口 → 局域网 → Tailscale → VPN → 掉线隧道 → 非回环当前地址。
  - 「中继」是 `GET /api/system/addresses` 下发的 `relayAccessUrl`（`<中继>/n/<本机 nodeId>`），复用分享侧的入口探测，探不通则不列。回环地址一律丢弃。
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

## 确认加入：准入 + 下发成员密钥

中继模式下「确认加入」要签两条密钥日志记录：`admit-node`（承认新节点）与 `meta-key {op:'admit'}`（把成员密钥交给新节点，缺了它新节点解不开元数据块）。界面把它们当作**一次操作的两步**，设置页的待确认列表与面板的「确认加入」步骤读同一份引擎状态，文案与按钮一致。

为什么 passkey 要验证两次：passkey 签一条记录就是一次 WebAuthn 断言，challenge 是该记录字节的 SHA-256，一次断言罩不住两条记录（改它需要动协议）。根密码用户派生出根钥后两条都静默签完，不受影响。因此：

- 「通行密钥需验证两次。」有两处：凭据框（`passkeyCeremonies: 2`），以及确认按钮旁的常驻提示 `PasskeyTwiceHint`（`apps/fe/src/auth/passkey-twice-hint.tsx`，设置页待确认行与面板共用）。后者是主路径：生成加入码时用过的 passkey 还在 5 分钟复用窗口里，点确认不再弹框。提示在「有第二步」且「将要用的签名者是 passkey」时出现——复用窗口里是 passkey，或窗口为空而当前入口有可用 passkey；窗口里是根钥、只能用密码、没有第二步、或这次只是重发未确认记录时不出现。
- 第二次仪式在同一次用户操作里紧接着发起（`admit-node` 落账、写锁放开后直接跑，不另排定时器）。它并不在点击的用户激活窗口内——前面已经隔了第一次仪式和几次网络往返；浏览器若不放行第二次验证，状态落到 `keyPending`，由「补发成员密钥」按钮（一次新的用户手势）补上。
- 不是用户手势发起的 admit（轮询 / 推送自动签、未确认记录的自动重发）只有手上是根钥时才自动跑第二步；否则直接进 `keyPending`，不从定时器里起 passkey 仪式。

状态在 `EnrollmentEngineState.progressById[enrollmentId]`（`apps/fe/src/node/admit-progress.ts` 维护）：

| `phase` | 含义 | 界面 |
|---|---|---|
| `admitting` | 第一步在签 / 在提交 | 确认按钮转圈；两步时标「1/2 确认加入」 |
| `distributing` | `admit-node` 已落账，正在下发成员密钥 | 「2/2 下发成员密钥」 |
| `done` | 全部落账 | 「节点已加入」（面板：「新机器已加入。」）；toast 只在此刻报一次 |
| `keyPending` | 节点已加入，成员密钥没签成 | 一句说明 + 「补发成员密钥」，只再验证一次；失败时句后跟红字原因（`keyError`，按 `relayErrorText` 翻译），用户自己取消验证则不带原因 |
| `expired` | 加入码过期 | 「加入码已过期，请重新生成。」 |

- `steps` 为 2 表示有第二步（消费方给了 `AdmitContext.followUp`，即 `useRelayAdmitFollowUp()` 在中继模式下的返回值）。有没有第二步取决于中继状态，状态没拉到（`relay.loadedAt === null`）之前两个挂载点都不参与签名（`admitModeOnceRelayKnown` 把交给引擎的 `mode` 置空），面板的确认按钮同时禁用并转圈——否则刷新后立刻点确认会按单步签完、漏掉成员密钥却报「已加入」。
- `admittedIds`、未确认重发、签名者租约、写锁与去重的语义不变：`admit-node` 一落账 pending 就清、加入码就从 DOM 消失，后移的只是「完成」这个信号。
- 设置页里收尾的结果（`done` / `keyPending` / `expired`）留成一行，直到用户点关闭；只存在内存里，刷新即清。
- `keyPending` 与服务端真相对账（`reconcileMemberKeys`）：中继状态每次刷新时，已知 node id 的待补发行若不在 `metaKeyLagging` 里（常驻重试回路把已签字节送到了，或别的标签页 / 设备补发了），收成 `done` 并报那一次「节点已加入」。只认进入 `keyPending` 之后拉到的状态。解不出 node id 的行对不上名单，由告警条的补发结果收尾（`markMemberKeysDelivered`）。
- 补发入口每台节点只留一个：结果行正在下发或待补发的节点不进「成员密钥未送达」告警条（`withoutRowOwned`）；刷新后结果行没了，告警条照常兜底。
- 失败不只靠 toast：`failureById[enrollmentId]` 存一条 i18n key（新节点尚未响应、记录过期需重签、服务端错误码、超时 / 断网的通用提示「确认加入失败，请重试。」），行内红字显示并把按钮换成「重试」，下一次确认开始时清掉；「新节点尚未响应」在证书到达时即清。通用提示背后的原始异常记在控制台（`[enroll] …`）。证书判定失败仍走 `invalidById`，上级未确认仍走 `unconfirmedIds`。
- 欠账名单拉不到（`status()` 失败）按失败处理并带错误码，不当作「没有欠账」。
- 读屏：进度与结果文字在 `role="status"` 容器里，失败原因是 `role="alert"`。

## 非标端口

中继可以架在 443 以外的高位端口（运营商封 80/443 时的常规做法）。面板里展示的加入命令带的是公开地址的原样端口，不需要额外处理；
用户手输地址的地方（接入向导、中继接入 / 追加 / 迁移对话框、`vibeterm relay join` / `vibeterm relay enroll`）在没写端口时会先探 443，再探内置候选端口，
探到就把地址补全成带端口的形式。角色入站口、HTTPS 候选表与部署形态见 [角色入站端口与非标 HTTPS](../operations/nonstandard-ports.md)。

## 测试

- `apps/fe` 单测覆盖面板默认标签、命令块内容、侧栏入口 href、设备菜单首项与分隔、向导两分支与锁定；e2e `devices.spec.ts`。
- 确认加入的两步与结果：`enrollment-engine.test.ts`（「加入进度」一组）、`admit-progress.test.ts`、`passkey-twice-hint.test.tsx`、`use-relay-admit-follow-up.test.ts`、`relay-meta-key-admit.test.ts`、`enrollment-section.test.tsx`、`connect-devices-panel.test.tsx`（步骤 6）、`credential-prompt.test.tsx`。
