# 已知问题（Known Issues）

本文件登记**尚未解决**的已知问题。解决后从本文件移除（背景留在对应模块文档里）。
最近核对：2026-09-05（1.1.34）。

## KI-1：e2e / 单测的负载抖动基线

`cd apps/fe && bun run test:e2e` 标准套件在 1.1.32 上为 108 pass / 3 fail / 1 skip，失败的三条
（`terminal-mouse-recovery:411`、`terminal-render-regressions:478`、`terminal-selection-canvas:139`）
在隔离定向复跑中 16/16 通过，属高负载下的渲染时序抖动，不是产品缺陷。mesh 套件 12/12。

判断某个分支是否引入回归时以**定向复跑**为准，不要拿本机全量 e2e 当唯一依据。gateway 全量单测在高负载
下 `dc-handshake`、`run-command` 的 `--More--` 用例也偶发失败，隔离复跑通过。

## KI-3：直连 ICE 候选无法按网卡过滤

`node-datachannel@0.33.1` 没有网卡过滤 API，`docker0` / `utun*` 之类的候选仍会进入 ICE。
可用 `TMEX_RTC_PORT_RANGE` 收窄端口，但挡不住多余候选。广播端的地址过滤见
[直连地址退避](./hub/2026090305-peer-endpoint-backoff.md)。

## KI-4：TURN 仍需手工配置三个环境变量

`TMEX_TURN_URL` / `TMEX_TURN_USERNAME` / `TMEX_TURN_CREDENTIAL` 必须齐备才会下发 TURN，且 node 侧
libjuice 只支持 UDP（`turns:` / `transport=tcp` 不产生 relay 候选）。是否内建 TURN 待按
`[mesh][rtc] summary` 的现网数据再定。

## KI-5：中继在途流保护的代价

`MAX_LINK_UNACKED` 提到 65 × 1 MiB，是「不误关满窗口中继流」的直接代价，单条 mux 最坏内存占用随之上升；
排空等待有 10 分钟硬上限，到期时剩余流仍会被 reset。见
[直连信令代次与链路活性](./hub/2026090502-rtc-signaling-epoch-link-liveness.md)。

## KI-6：待现网实测的两项

1. 推包途中重启中继 / 让节点顶号，确认 `.part` 保留、只补发剩余字节、最终升级成功。
2. 直连的 ICE-TCP 与 `TMEX_RTC_PORT_RANGE` 目前只有 fake / 内存传输的测试，缺真实 NAT 环境的集成验证。

## KI-7：`peer-manager.ts` 上帝类待拆

`apps/gateway/src/mesh/peer-manager.ts`（约 1900 行 81 成员）的拆分（`peer-dialer.ts` /
`peer-live-registry.ts`）尚未立项。同批的 ctl switch 合并与 `uplink-server.ts` 拆分已于第二十九轮完成。

## KI-8：Hub 转发不把浏览器来源 IP 带给节点

节点侧看到的 clientIp 恒为 `peer:<hubNodeId>`（`dispatchInboundHttp` 写入），`x-forwarded-*` 两端都被剥。
因此节点自己的分享登录限速在 Hub 路径上会把所有访客算成同一个来源。当前由 Hub 侧按（真实来源 IP, shareId）
的配额兜住（`apps/gateway/src/mesh/share-login-quota.ts`），实际不会误锁别人；但节点端限速在这条路径上
仍是空转。彻底解法是给 peer 上下文加一条 Hub 可信填写、浏览器不可覆盖的来源 IP 元数据。
见[终端分享](./share/2026090503-terminal-share.md)。

## KI-9：本机自升级没有下载字节进度

远程升级的下载进度已在 1.1.34 补齐（原 KI-2），本机自升级仍只有阶段名：`UpgradeStatus` 的 `progress`
面按合约只服务远程升级，`stageGithubRelease` 没有上报出口，且 `apps/gateway/src/system/upgrade.ts`
贴着 allowlist 的行数上限，新开一条进度通道要先拆文件。
