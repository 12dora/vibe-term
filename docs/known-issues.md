# 已知问题（Known Issues）

本文件登记**尚未解决**的已知问题。解决后从本文件移除（背景留在对应模块文档里）。
最近核对：2026-09-05（1.1.32）。

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

第二十九轮已完成两项：两条线的 ctl switch 合并为 `packages/shared/src/uplink/codec-decode.ts` 的参数化
`decodeUplinkCtl`，编码侧 mesh 归一到 hub 线上表示后复用 hub 实现；`apps/gateway/src/hub/uplink-server.ts`
（2224 行）拆为会话 / 联邦 / 节点表 / key log / RTC 五个协作者，`UplinkServer` 只剩装配与 `onCtl` 分派。

余下 `apps/gateway/src/mesh/peer-manager.ts`（1907 行 81 成员）的拆分（`peer-dialer.ts` /
`peer-live-registry.ts`）尚未立项。
