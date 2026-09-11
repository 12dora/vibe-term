# 已知问题（Known Issues）

本文件登记**尚未解决**的已知问题，面向开发者与运维。解决后从本文件移除（背景留在对应模块文档里）。

## KI-1：e2e / 单测的负载抖动基线

`cd apps/fe && bun run test:e2e` 标准套件在 1.1.32 上为 108 pass / 3 fail / 1 skip，失败的三条
（`terminal-mouse-recovery:411`、`terminal-render-regressions:478`、`terminal-selection-canvas:139`）
在隔离定向复跑中 16/16 通过，属高负载下的渲染时序抖动，不是产品缺陷。mesh 套件 12/12。

判断某个分支是否引入回归时以**定向复跑**为准，不要拿本机全量 e2e 当唯一依据。gateway 全量单测在高负载
下 `dc-handshake`、`run-command` 的 `--More--` 用例也偶发失败，隔离复跑通过。

## KI-3：直连 ICE 候选无法按网卡过滤

`node-datachannel@0.33.1` 没有网卡过滤 API，`docker0` / `utun*` / Tailscale `100.x` / 代理 TUN
`198.18.0.1` 之类的 host 候选仍会进入 ICE。可用 `VIBETERM_RTC_PORT_RANGE` 收窄端口，但挡不住
多余候选——代价是多余的候选对拖长 ICE 检查、日志变吵，不影响正确性。广播端的地址过滤见
[节点直连](./architecture/peer-direct-connect.md)。本地 gathering 完成时会打 info
`[mesh][rtc] gather summary … host= srflx= relay= stun_count= turn=`，用来确认实际进 ICE 的候选类型。

STUN 主机名被本机代理解析成 fake-IP、从而零 srflx 的问题已在节点侧 ICE 配置路径绕开
（见 [隧道边缘与 STUN 的 fake-IP 绕行](./operations/tunnel-edge-fake-ip.md)）；代理 TUN 吞掉境外 UDP
的情形见 KI-13。本条只剩「多余 host 候选无法按网卡丢掉」。

## KI-4：TURN 仍需手工配置三个环境变量

`VIBETERM_TURN_URL` / `VIBETERM_TURN_USERNAME` / `VIBETERM_TURN_CREDENTIAL` 必须齐备才会下发 TURN，且 node 侧
libjuice 只支持 UDP（`turns:` / `transport=tcp` 不产生 relay 候选），且 **UDP mux 模式下不支持 TURN**（libjuice 告警 `TURN servers are not supported in mux mode`，只出 host 候选）——2.2.2 之前网关写死 `enableIceUdpMux: true`，TURN 配置从未生效；2.2.2 起配置了 TURN 就关 mux。现网随后发现：节点 UDP 到不了 TURN 时 gathering 会挂死且 **连 srflx 也不出**（`local_types=[host]`，没有 `gather summary`），全网一条不可达的 TURN 等于毁掉所有打洞。因此改为对本机 TURN 做 STUN Binding 可达探测（coturn 会应答 Binding；这只证明 UDP 通，不是带凭证的 Allocate）：探测成功才把 TURN 纳入 `iceServers` 并关 mux；失败则从 ICE 里拿掉 TURN、保持 mux；尚未探测时先纳入 TURN 但 mux 仍开。`GET /api/mesh/rtc-config` 的 `turn` 是实际在用的值，下发/本地原值在 `turnConfigured`，探测结果在 `turnProbe`（与 STUN 的 `probes` 并列）。是否内建 TURN 待按
`[mesh][rtc] summary` / `gather summary` 与 STUN 自检（`[mesh][rtc] stun probe`，结果挂在
`GET /api/mesh/rtc-config` 的 `probes`）的现网数据再定。STUN 列表 2.2.0 起随发行版内置分发（小米 / Bilibili 打头 + Google / Cloudflare 冗余），
`VIBETERM_STUN_SERVERS` 未设置即用内置列表、`none` 禁用；hub / 中继只在自己设了自定义列表时才下发，
下发空列表表示「没有自定义」，节点回到自己的内置列表。TURN 相反：hub / 中继下发过就以它为准，
显式 `turn: null` 即撤回，节点不再回落本机 `VIBETERM_TURN_*`。超时失败会标 `stun_unconfigured` 或 `no_srflx`。

## KI-5：中继在途流保护的代价

`MAX_LINK_UNACKED` 提到 65 × 1 MiB，是「不误关满窗口中继流」的直接代价，单条 mux 最坏内存占用随之上升；
排空等待有 10 分钟硬上限，到期时剩余流仍会被 reset。见
[节点直连](./architecture/peer-direct-connect.md)。

## KI-6：待现网实测的两项

1. 推包途中重启中继 / 让节点顶号，确认 `.part` 保留、只补发剩余字节、最终升级成功。
2. 直连的 ICE-TCP 与 `VIBETERM_RTC_PORT_RANGE` 目前只有 fake / 内存传输的测试，缺真实 NAT 环境的集成验证。

## KI-8：Hub 转发不把浏览器来源 IP 带给节点

节点侧看到的 clientIp 恒为 `peer:<hubNodeId>`（`dispatchInboundHttp` 写入），`x-forwarded-*` 两端都被剥。
因此节点自己的分享登录限速在 Hub 路径上会把所有访客算成同一个来源。当前由 Hub 侧按（真实来源 IP, shareId）
的配额兜住（`apps/gateway/src/mesh/share-login-quota.ts`），实际不会误锁别人；但节点端限速在这条路径上
仍是空转。彻底解法是给 peer 上下文加一条 Hub 可信填写、浏览器不可覆盖的来源 IP 元数据。
见[终端分享](./architecture/terminal-share.md)。

## KI-9：本机自升级没有下载字节进度

远程升级的下载进度已在 1.1.34 补齐（原 KI-2），本机自升级仍只有阶段名：`UpgradeStatus` 的 `progress`
面按合约只服务远程升级，`stageGithubRelease` 没有上报出口，且 `apps/gateway/src/system/upgrade.ts`
贴着 allowlist 的行数上限，新开一条进度通道要先拆文件。

## KI-10：旧版本入口节点操作新版本节点上的远程窗格会被拒

`/api/mesh-internal/tmux/*` 要求窗格授权（见
[远程 agent 窗格授权](./architecture/agent-remote-pane-grant.md)）。目标节点已升级、发起节点仍是旧版本时，
旧发起方不会带授权，远端窗格的 agent 会话会一直收到 403 `PANE_GRANT_REQUIRED`。发起节点升级后，
下一次发消息 / 改绑窗格就会自动补签，无需人工干预；升级前该会话不可用。

## KI-11：旧版本入口推包给新版本节点会卡在装包这一步

发行包签名自 1.1.39 起生效（见[发行包签名](./operations/release-signing.md)）。新节点只装
「带可验签清单」的暂存包，而旧版本入口不会发 `POST /api/system/upgrade/package/manifest`：字节能推上去，
装包一步返回 `UPGRADE_SIGNATURE_REQUIRED`，节点停在原版本（不会装上任何东西，安全侧是对的）。
处置：先把入口升到 1.1.39+，再对节点发起升级；或者在节点本机跑一次 `vibeterm upgrade`。

`install.sh` 首次安装仍只校验 SHA256SUMS，没有验签——shell 里没有可依赖的 Ed25519 实现，
首次安装本来也要信任下载源。

另一侧的限制：远程发起的升级（入口 / hub 转发过来的 `POST /api/system/upgrade`）一律要求目标版本
≥ 1.1.39。想让某个节点装回更早的版本，只能在那台机器上本机执行 `vibeterm upgrade --version <ver>`；且**升到 2.0.0 完成安装目录迁移之后不支持降回 1.x**（旧 CLI 只认旧目录、旧 label 与 `TMEX_*` 键），见 [改名迁移](./operations/rename-migration.md)。

## KI-12：混合版本网内旧目标节点仍把所有转发流收尾报成 4401

2.0.8 之前的节点在拆掉任何转发来的浏览器终端流时（链路抖动、入口迁移流、读失败）都会回
`vibeterm-close:4401:NODE_LOGIN_REQUIRED`，入口据此把「需要登录」透给浏览器。修复在**目标节点侧**
（见 [mesh 架构](./architecture/mesh-architecture.md) §3），只升级入口不解决：新版入口连旧目标仍会收到
误报的 4401。2.0.8 起前端收到 4401 会先用带会话的 HTTP 探测再下结论，能把症状压成一次退避重连，
但根治要把全网节点升到 ≥ 2.0.8。

## KI-13：本机代理 TUN 不转发境外 UDP 时拿不到 srflx

Surge / Clash 等增强模式把 UDP 收进 TUN 后，若代理链路本身不中继境外 UDP，Google `:19302` /
Cloudflare `:3478` 的 STUN Binding 常年无应答，节点只剩 host 候选，跨 NAT 一律回落中继。节点侧的
fake-IP 解析器只解决「主机名被解析成 `198.18.x`」，解决不了「UDP 出不去」。处置二选一：用内置列表里
国内可达的 `stun.miwifi.com` / `stun.chat.bilibili.com`（自定义 `VIBETERM_STUN_SERVERS` 时至少留一条
可达的），或者在代理里给 UDP 3478 / 19302 加 DIRECT 规则。判定看 `[mesh][rtc] stun probe … ok=false
error=timeout` 与 `GET /api/mesh/rtc-config` 的 `probes`。浏览器 ICE 走浏览器自己的网络栈，同样要求
本机 UDP 出得去。详见 [隧道边缘与 STUN 的 fake-IP 绕行](./operations/tunnel-edge-fake-ip.md)。
