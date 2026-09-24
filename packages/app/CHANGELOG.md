# 2.9.0

_2026-09-24_

## English

### Fixes

- Opening several machines through a relay no longer times out in waves. The root causes were all on the target side: a direct DataChannel was treated as ready 5 s after it opened and the relay was torn down, but on many networks that channel was cut about 10 s after opening; the loss was then counted as a dial failure, so the machine was locked out of direct for 16 minutes and every next request had to rebuild the relay. VibeTerm now keeps the relay until the direct link has answered a ping and stayed up for 15 s, puts the relay back if the direct link dies early, and backs off unstable direct links without counting them as failures.
- Machines that can never be reached directly (for example an old hub behind a firewall) are no longer redialed every few seconds. A relay hiccup used to wipe the direct-connect breaker; now it only resets on real changes such as a new address, and a refused offer is answered at once instead of burning 15 s and a TURN allocation each time.
- A loop where two machines kept opening and resetting the same connection every 30 ms is gone.
- Browser direct connection now actually works when you go through a relay entry. The target used to wait for a fingerprint that never arrived, so every attempt failed after 5–7 s and the browser retried forever. Temporary failures no longer switch direct off for 10 minutes, and the browser no longer restarts its retry burst on every reconnect.
- Large uploads through a relay are no longer held back by the new retry logic.
- Setting a machine's memory limit to "no limit" now really clears it and says so. Previously the page kept showing days-old 8 GB / 12 GB readings, and a window left over from earlier could keep its old limit. VibeTerm now keeps reading memory while limits are off, verifies that each limit it had set was actually removed, also clears leftover windows it started, and never touches limits you set yourself.
- The terminal's "Connecting to device…" screen now explains after 8 seconds what it is waiting for and offers a reconnect button, instead of spinning forever.

### Improvements

- Memory-limit dialogs ask you to choose "No limit" or "Custom limits" explicitly; the bulk dialog can no longer apply default limits to every node by accident, and "No limit" keeps each node's own sampling interval.
- Old memory readings are shown as out of date instead of as the current limit, in the browser and in `vibeterm sessions --memory`.
- `vibeterm login` reports progress per node, times out per node and logs in to several nodes at once.
- Relay and direct-path selection use each link's real round-trip time, and a node's public address is taken from what the relay actually sees.

---

## 中文

### 修复

- 经中继同时打开多台机器时，不再成片超时。根因都在目标一侧：直连 DataChannel 打开 5 秒就被当成可用并拆掉中继，但在不少网络里这条通道会在打开约 10 秒后被掐断；随后又被算成一次拨号失败，这台机器 16 分钟内都不再尝试直连，下一次请求只能重建中继。现在要等直连回应过 ping 并稳定 15 秒才拆中继，直连提前断掉会把中继接回来，不稳定的直连只做退避、不再算作失败。
- 永远连不上直连的机器（比如防火墙后的老 hub）不再每隔几秒被重拨。过去中继一抖就把直连熔断清零；现在只有地址变化这类真实变化才重置，对方拒绝时也会立即回复，不再每次白白耗掉 15 秒和一次 TURN 分配。
- 修复两台机器每 30 毫秒反复打开又重置同一条连接的循环。
- 经中继入口访问时，浏览器直连终于能建立了。目标此前一直在等一个永远不会出现的指纹，每次 5–7 秒后失败，浏览器无限重试。暂时性失败不再把直连关掉 10 分钟，每次重连也不再重新开始一轮重试。
- 新的重试逻辑不会再卡住经中继的大文件上传。
- 把机器的内存限额设为「不限制」后，现在会真正解除并如实显示。过去页面一直显示几天前的 8 GB / 12 GB 读数，早先遗留的窗口也可能保留旧限额。现在关闭限额后仍持续采样，逐个核实自己施加过的限额已解除，也会清理由它启动的遗留窗口，而你自己设置的限额不会被动。
- 终端「连接设备...」界面 8 秒后会说明正在等什么，并提供「重新连接」，不再无限转圈。

### 改进

- 内存限额对话框要求明确选择「不限制」或「自定义限额」；批量对话框不会再误把默认限额写给所有节点，「不限制」保留各节点自己的采样周期。
- 过期的内存读数在浏览器和 `vibeterm sessions --memory` 中显示为已过期，不再冒充当前限额。
- `vibeterm login` 逐节点报告进度、每台单独超时，并同时登录多台。
- 中继与直连选路按每条链路的真实往返时间计算，节点公网地址以中继实际看到的为准。
