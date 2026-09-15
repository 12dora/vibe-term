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

代理 fake-IP（`198.18.0.0/15`）的 host 候选已在**信令层收发两侧**丢弃（日志 `signal dropped … cause=fake-ip`），
RFC1918 地址保留，局域网直连不受影响。

STUN 主机名被本机代理解析成 fake-IP、从而零 srflx 的问题已在节点侧 ICE 配置路径绕开
（见 [隧道边缘与 STUN 的 fake-IP 绕行](./operations/tunnel-edge-fake-ip.md)）；代理 TUN 吞掉境外 UDP
的情形见 KI-13。本条只剩「多余 host 候选无法按网卡丢掉」。

## KI-4：TURN 只走 UDP，端口要运营者自己放行

中继角色**自带 TURN**（`VIBETERM_TURN_PORT`，默认 `40000`/UDP；中继端口段 `VIBETERM_TURN_RELAY_PORT_RANGE`，默认
`40001-40049`），长期凭据首启生成后落 `gateway_kv`，随 `auth.ok` / `relay.list` 下发给租户节点，不再需要手配三个环境变量。中继主机 ICE 缺省 `40050-40099`，与 TURN 错开；全部 UDP 落在 40000-40099。
配齐 `VIBETERM_TURN_URL` / `_USERNAME` / `_CREDENTIAL` 则改用外部 TURN、内置不启动。
部署与排查见 [mesh 运维](./operations/mesh-operations.md)，协议与状态字段见 [公共中继角色](./architecture/relay.md)。剩下的边界：

- **只有 UDP**：节点侧 ICE 由 node-datachannel（libjuice）实现，`turns:` 与 `?transport=tcp` 不产生 relay 候选；内置 TURN
  也只中继 UDP/IPv4（IPv6 peer 直接 400）。本机 UDP 出不去时（KI-13）仍只能走中继流。
- **防火墙必须人工放行**：用户级服务碰不了云安全组 / ufw。`init` / join / `doctor` / 接入向导会打印角色端口计划；`GET /api/mesh/nodes[].ports` 与 `POST …/ports/probe` 把 peer / ICE 标成 `open|blocked|unknown`（连续两次失败才 `blocked`）；TURN 磁贴有 `membersProbe`（成员 Binding 可达 ok/total）。少放一段仍是节点探测失败、TURN 不进 ICE，日志里没有任何报错——探测与 UI 只让问题可见，改不了防火墙。
- **宿主跑 TUN 代理时必须绑具体地址**：2.3.0 内置 TURN 绑 `0.0.0.0`，在 mihomo / clash `auto-route` 的宿主（如上海中继）上回包
  被 `from 0.0.0.0 iif lo` 策略路由吸进 TUN、以 `198.18.0.1` 源地址发出，全网探测超时且无任何报错。2.3.1 起默认
  `VIBETERM_TURN_BIND_HOST=auto`（主出站 IPv4）；显式设回 `0.0.0.0` 会复现该问题。
- **最多两条 TURN 进 ICE**：节点对每条下发的 TURN URL 做 STUN Binding 可达探测，只有探测 `ok` 的按 RTT 取前两条进
  `iceServers`；失败或尚未探测一律排除（早期「先纳入、探测后再说」会让 gathering 连 srflx 一起挂死）。列表里真有 TURN 时才关
  UDP mux（libjuice mux 不支持 TURN）。探测只证明 UDP 通，不等于带凭证的 Allocate 能成。
- `GET /api/mesh/rtc-config`：`turn` 是实际进 ICE 的数组（0–2 条），`turnConfigured` 是全部已知条目，`turnProbes` 每条
  configured URL 一份探测记录（`turnProbe` 保留为第一条的记录，兼容旧前端）。

## KI-5：中继在途流保护的代价

`MAX_LINK_UNACKED` 提到 65 × 1 MiB，是「不误关满窗口中继流」的直接代价，单条 mux 最坏内存占用随之上升；
排空等待有 10 分钟硬上限，到期时剩余流仍会被 reset。见
[节点直连](./architecture/peer-direct-connect.md)。

## KI-6：待现网实测的两项

1. 推包途中重启中继 / 让节点顶号，确认 `.part` 保留、只补发剩余字节、最终升级成功。
2. 直连的 ICE-TCP 与 `VIBETERM_RTC_PORT_RANGE`（`init` / upgrade 按角色写入统一段 40000-40099）目前只有 fake / 内存传输的测试，缺真实 NAT 环境的集成验证。UI 不承诺 ICE-TCP 单独可达。

## KI-8：入口转发不把浏览器来源 IP 带给目标节点

节点侧看到的 clientIp 恒为 `peer:<entryNodeId>`（`dispatchInboundHttp` 写入），`x-forwarded-*` 两端都被剥。
因此目标节点自己的分享登录限速会把所有经该入口转发的访客算成同一个来源。当前由入口按（真实来源 IP, shareId）
的配额兜住（`apps/gateway/src/mesh/share-login-quota.ts`），实际不会误锁别人；但目标节点端限速在这条路径上
仍是空转。彻底解法是给 peer 上下文加一条入口可信填写、浏览器不可覆盖的来源 IP 元数据。
见[终端分享](./architecture/terminal-share.md)。

## KI-9：本机自升级没有下载字节进度

远程升级的下载进度已在 1.1.34 补齐（原 KI-2），投递失败现为通道聚合串（`github(node): …; push: …`），
GUI 与 CLI 原文展示。本机自升级仍只有阶段名：`UpgradeStatus` 的 `progress` 面按合约只服务远程升级，
`stageGithubRelease` 没有上报出口，且 `apps/gateway/src/system/upgrade.ts` 贴着 allowlist 的行数上限，
新开一条进度通道要先拆文件。

## KI-10：旧版本入口节点操作新版本节点上的远程窗格会被拒

`/api/mesh-internal/tmux/*` 要求窗格授权（见
[远程 agent 窗格授权](./architecture/agent-remote-pane-grant.md)）。目标节点已升级、发起节点仍是旧版本时，
旧发起方不会带授权，远端窗格的 agent 会话会一直收到 403 `PANE_GRANT_REQUIRED`。发起节点升级后，
下一次发消息 / 改绑窗格就会自动补签，无需人工干预；升级前该会话不可用。

## KI-11：旧版本入口推包给新版本节点会卡在装包这一步

发行包签名自 1.1.39 起生效（见[发行包签名](./operations/release-signing.md)）。新节点只装
「带可验签清单」的暂存包，而旧版本入口不会发 `POST /api/system/upgrade/package/manifest`：字节能推上去，
装包一步返回 `UPGRADE_SIGNATURE_REQUIRED`，节点停在原版本（不会装上任何东西，安全侧是对的）。
2.3.7+ 入口会交签名清单，且优先让节点自拉 GitHub；本条只剩入口仍 < 1.1.39 的混合版本网。
处置：先把入口升到 1.1.39+，再对节点发起升级；或者在节点本机跑一次 `vibeterm upgrade`。

`install.sh` 首次安装仍只校验 SHA256SUMS，没有验签——shell 里没有可依赖的 Ed25519 实现，
首次安装本来也要信任下载源。

另一侧的限制：远程发起的升级（入口转发过来的 `POST /api/system/upgrade`）一律要求目标版本
≥ 1.1.39。想让某个节点装回更早的版本，只能在那台机器上本机执行 `vibeterm upgrade --version <ver>`；且**升到 2.0.0 完成安装目录迁移之后不支持降回 1.x**（旧 CLI 只认旧目录、旧 label 与 `TMEX_*` 键），见 [改名迁移](./operations/rename-migration.md)。

## KI-12：混合版本网内旧目标节点仍把所有转发流收尾报成 4401

2.0.8 之前的节点在拆掉任何转发来的浏览器终端流时（链路抖动、入口迁移流、读失败）都会回
`vibeterm-close:4401:NODE_LOGIN_REQUIRED`，入口据此把「需要登录」透给浏览器。修复在**目标节点侧**
（见 [mesh 架构](./architecture/mesh-architecture.md) §3），只升级入口不解决：新版入口连旧目标仍会收到
误报的 4401。2.0.8 起前端收到 4401 会先用带会话的 HTTP 探测再下结论，能把症状压成一次退避重连，
但根治要把全网节点升到 ≥ 2.0.8。

**不要把 1011 当成 4401。** 新入口在 Upgrade 101 **之后** `getLink` 失败关的是 **1011**（reason `node-unreachable` / `forward-link-timeout`），鉴权失败才在 101 之前关 4401。前端须按链路失败短退避，不得走登录探测。HTTP `/n/:id/api/*` 冷拨仍可能 503 `NODE_UNREACHABLE`。

## KI-13：本机代理 TUN 不转发境外 UDP 时拿不到 srflx

Surge / Clash 等增强模式把 UDP 收进 TUN 后，若代理链路本身不中继境外 UDP，Google `:19302` /
Cloudflare `:3478` 的 STUN Binding 常年无应答，节点只剩 host 候选，跨 NAT 一律回落中继。节点侧的
fake-IP 解析器只解决「主机名被解析成 `198.18.x`」，解决不了「UDP 出不去」。处置二选一：用内置列表里
国内可达的 `stun.miwifi.com` / `stun.chat.bilibili.com`（自定义 `VIBETERM_STUN_SERVERS` 时至少留一条
可达的），或者在代理里给 UDP 3478 / 19302 加 DIRECT 规则。判定看 `[mesh][rtc] stun probe … ok=false
error=timeout` 与 `GET /api/mesh/rtc-config` 的 `probes`。浏览器 ICE 走浏览器自己的网络栈，同样要求
本机 UDP 出得去。直连协商已减到 1 次转发 REST（HELLO `connection-id:` + entry `rtc-config`），建立变快，但**不保证**移动网 ICE 成功。详见 [隧道边缘与 STUN 的 fake-IP 绕行](./operations/tunnel-edge-fake-ip.md)。

iOS 切网：`/ws` 与 `/n/:id/ws` 走 2–6 s 短期限探测（`pageshow` 不论 persisted）。`/mesh/ws` 在会回 PONG 的网关上前台 2.5–4 s 发现僵尸；2.3.0 网关忽略应用层 PING，仍可能要等 30 s 静默门槛。

## KI-15：本机代理 TUN 丢弃境外 UDP 时，TURN 探测只代表本机

本机代理 TUN（Surge / mihomo 一类）下，若命中的代理策略不转发 UDP（Surge 的 `ss` 策略未开 `udp-relay`，
`udp-policy-not-supported-behavior` 默认 REJECT；mihomo 同理），节点对非直连目的地的所有 UDP 都会被本机丢掉：
对该中继 TURN 控制口的 STUN Binding 探测一直 `error=timeout`，境外公共 STUN（Google / Cloudflare）同样超时，
而国内直连目的地的探测正常。现网例：本机（Surge）与一台跑 mihomo 的节点探东京中继 `turn:152.70.84.203:40000` 超时，
无 TUN 的 jiefa-app 与 oracle 自身探测 `ok`。此前记录的「同机裸 `dgram` 有回包」是探测脚本把「已发送数」当「回包数」
打印造成的误判，UDP 实际不可达。

影响：该节点不把这个 TURN 纳入 ICE（`turn gate … reachable=` 少一条），走另一中继的 TURN 或中继流；不影响其它节点。
界面从 2.3.6 起按「本机不可达 · N/M 节点可达」标注，并在金丝雀判定本机为 TUN 时提示「探测结果仅代表本机」；
`vibeterm relay list` 的 TURN 列同样带节点计数。

处置（在代理侧，二选一）：给该中继 IP 加直连规则（Surge：`IP-CIDR,152.70.84.203/32,DIRECT,no-resolve`；mihomo：
`IP-CIDR,152.70.84.203/32,DIRECT`），或给代理策略开 UDP 转发（`udp-relay=true`，要求服务端支持）。判定看
`[mesh][rtc] turn probe url=… ok=false error=timeout` 与同机 `stun:stun.l.google.com:19302` 是否同时超时。

## KI-14：混合版本网内的直连抖动

2.3.0 修掉了三处「一升级直连就抖」的成因：DC 握手先挂接收队列并按类型去重（hello 间隔 500 ms、队列 64）、DC 取代中继/ws-secure
时 make-before-break（还有内层流就不发 `replaced` RST 去砸整条中继 uplink）、DC 空闲拆链从 5 min 放宽到 30 min。修复在**各自节点侧**，
混合版本网里仍有残留：

- 旧对端（≤ 2.2.x）作为 offerer 仍按 40 ms 狂发 hello，作为被取代方仍会立刻 `reset('replaced')`，对面那条中继流照样被 RST；
- 旧对端的 ctl ping 不回显 `sentAt`，新节点只能退回本地发送时刻算 RTT，样本里仍含发送队列等待。

处置只有一个：把两端都升到 ≥ 2.3.0。

## KI-16：没有短时、作用域收窄的 exec 令牌

`POST /api/exec` 与其它 `/api/*` 一样走完整 node-session，没有「只许跑这一条命令、过期即废」的服务端 scoped bearer。
AI agent / CI 目前只能把完整会话能力交给调用方：默认 `~/.config/vibeterm/session.json`，或用
`$VIBETERM_SESSION_FILE` 指到独立路径（0600，group/world 可读会拒绝加载）。拿到该文件等于拿到一个浏览器会话。
后续若做短时 exec token，应在网关签发、按设备 / 命令 / TTL 收窄，并让 CLI 优先于会话 cookie 出示。
见 [远程执行](./architecture/remote-exec.md)、[CLI 使用手册](./operations/cli-usage.md)。

## KI-17：libdatachannel DTLS / libjuice 死锁会永久卡住网关主线程

`node-datachannel@0.33.1`（libdatachannel v0.24.3 + libjuice）在 **DTLS server（offerer）+ ICE 选中 TURN relay + ClientHello 已排队** 时，libjuice poll 线程与 RTC worker 形成 AB-BA 死锁：前者持 juice registry 锁跑 ICE 回调并在 `DtlsTransport::handleTimeout()` 等 `mSslMutex`，后者在 `doRecv()` 持 `mSslMutex` 并在 `juice_send` / `agent_send` 上等 registry。Bun 主线程若此时进入同步 N-API `getSelectedCandidatePair`（`apps/gateway/src/mesh/rtc/rtc-peer-helpers.ts` 的 `onIceStateChange`），会永远阻塞。

症状：`systemctl is-active` / launchd 仍为 running，`/healthz` 超时，listen backlog 打满（Recv-Q ≥ Send-Q），无新日志。`EventLoopLagSampler` 与健康检查都跑在主线程上，发现不了。JS 侧无法通过少调 native 避开——后续任意 N-API 同样会堵。

上游修复 [libdatachannel PR #1630](https://github.com/paullouisageneau/libdatachannel/pull/1630)（`handleTimeout()` → `enqueueRecv()`）尚未合入；node-datachannel 0.33.4 / libdatachannel v0.24.5 也不含该行。产品侧用进程内事件循环看门狗把永久挂死变成约 10–20 s 的自杀重启（见 [事件循环看门狗](./operations/gateway-loop-watchdog.md)）。

验证：生产启动应有 `[vibeterm][loop-watchdog] armed …`；卡死时应有 `main thread stalled …`、`<installDir>/loop-watchdog.log` 一行 JSON，随后服务被拉起。现场重启前用 `eu-stack -p <pid>` 核对 `agent_get_selected_candidate_pair` / `DtlsTransport::handleTimeout` / `agent_send`。`vibeterm doctor` 在服务 running 但 HTTP 无响应时 FAIL `loop-stall`。根因要等上游发版（或 vendor 补丁构建）才能从本文件移除。

## KI-18：TUN 代理 fake-IP 把中继域名解析成假地址时上联拨号超时

状态：已在 2.7.1 修复/缓解。

本机走 mihomo / Surge 一类 TUN 代理、且 DNS 回落打到一条已死的境外出口时，系统 lookup 会把中继域名「成功」解析成 fake-IP（`198.18.0.0/15`）。上联按这个地址拨号，TCP 进 TUN 后无回包，表现为 `connect-timeout`，中继本身是健康的。隧道边缘与 STUN 的 fake-IP 绕行（[隧道边缘](./operations/tunnel-edge-fake-ip.md)、KI-13 / KI-15）不覆盖这条 TCP 上联。

2.7.1 起：系统 lookup 仍先用 fake-IP 拨号（许多主机的 TUN 可用，且 DoH 可能被拦）；若 TCP 连接失败（`connect-timeout` / `ECONNREFUSED` / `EHOSTUNREACH` / `ENETUNREACH`），再走 DoH 解析真实 IP，按 IP + SNI 重拨，并在正缓存 TTL 内优先用真实 IP。关闭 `VIBETERM_DIAL_DNS_FALLBACK` 则行为与修复前相同。见 [公共中继「系统 DNS 失败时的 DoH 重拨」](./architecture/relay.md)。

人工规避（代理侧，二选一）：给中继域名钉国内解析（mihomo `nameserver-policy`），或加 DIRECT 规则绕开 TUN。
