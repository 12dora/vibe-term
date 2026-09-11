# 2.2.0

_2026-09-11_

## English

### New

- **Faster first screen on slow links.** Opening a terminal used to take several round trips before anything appeared: the browser had to wait for the session metadata, then ask for the screen, then wait for it. The browser now sends "connect this device and give me this screen" in the same batch right after the handshake, and the node answers with metadata and the first screen together — two exchanges instead of three. The terminal also appears immediately with a "connecting" overlay instead of an empty box. Both sides must run 2.2.0; against an older node the client falls back to the old sequence automatically.
- **STUN servers now ship with the release.** The list used to be frozen into `app.env` at install time, so a machine installed a year ago kept dialing a year-old list. The built-in list now travels with each release and takes effect on upgrade; upgrading removes the frozen default from `app.env` (a copy is kept under `backups/`). Set `VIBETERM_STUN_SERVERS` only to override it, or to `none` to switch STUN off. `vibeterm doctor` tells you which of the three is in effect.
- **Zombie connections are noticed in seconds.** When a phone comes back from the background, a connection that silently died used to take up to a minute and a half to be replaced. VibeTerm now probes the link on every return to the foreground with a deadline scaled to the measured round-trip time, and reconnects immediately if the probe times out — about 2 s on a fast link, 3 s on a slow one.

### Improvements

- **Cold start on a slow mobile link is roughly three times faster.** Measured at 400 ms round-trip / 2 Mbps, the first terminal content appears in 7.4 s instead of 21.7 s, and the bytes needed before it drop from 4.8 MB to 0.8 MB. Three changes together: scripts, styles and WebAssembly are now served pre-compressed (brotli / gzip); the terminal's default font is split so the first frame waits for a 45 KB latin subset instead of a 1.2 MB file (the full font loads afterwards and the screen is redrawn); and only the language you actually use is downloaded.
- **Timeouts follow the link instead of assuming a LAN.** Dial, forward and request deadlines are now derived from the measured round-trip time, so a node 800 ms away is no longer declared unreachable while it is still answering. Local-network behaviour is unchanged. An address that merely timed out backs off for at most 5 minutes (unreachable or refused addresses still back off for hours), and one successful dial clears that node's whole backoff.
- **The phone app updates itself.** An iOS home-screen PWA used to stay on the version installed on the day it was added, because the new app shell only activates when every old tab is gone — which never happens on a phone. It now takes over at safe moments (page load, or coming back to the foreground after at least 30 s away) and reloads once. On weak or metered links the app shell no longer precaches the 7.5 MB of lazy chunks; it fills them in when the link improves.
- Direct-connection negotiation no longer runs before the session exists (it used to burn several requests on a guaranteed 404 per remote node, on every connect), and `/api/rtc/authorize` failures now back off per node instead of retrying in a loop.
- Returning to the foreground no longer triggers a burst of REST requests: only the device list refetches on focus, and it still honours its 60 s freshness window. The mesh event stream also yields the first screen to the terminal and reconnects when it has been silent for 30 s.
- The connection details popover is rendered in a layer of its own and stays inside the visible viewport on phones, including with the keyboard open.

### Fixes

- A hub or relay that explicitly withdraws its TURN configuration is now respected: nodes stop falling back to their own local TURN settings.
- An empty STUN list from a hub means "I have no custom list", not "switch STUN off": the node keeps using the built-in list.
- Service worker: a first install is no longer mistaken for a version change, so the page does not reload for no reason.
- A language that was still locked at startup now really loads once unlocked (it used to stay as raw keys until the next full reload).

### Upgrade notes

- **The STUN change and the faster first screen only take effect once the hub and every node run 2.2.0.** Mixed versions keep working — each link falls back to the old behaviour on its own.
- **The phone PWA will reload itself once**, the first time you bring it back to the foreground after the upgrade. That is the takeover described above, not a crash.
- The release package grows by about 4 MB (the pre-compressed copies of the static assets).

---

## 中文

### 新增

- **慢链路上的首屏更快。** 打开终端此前要好几个来回才出画面：浏览器得先等会话元数据，再去要屏幕，再等屏幕回来。现在浏览器在握手之后的同一批里直接发出「连这台设备、给我这一屏」，节点把元数据和首屏一起回来——三次交换变两次。终端也不再是一个空框，而是立刻出现并叠一层「连接中」。需要两端都升到 2.2.0；对端是老版本时客户端自动回到旧时序。
- **STUN 服务器改为随发行版分发。** 此前这份列表在装机时就被冻进 `app.env`，一年前装的机器就一直在用一年前的列表。现在内置列表随每次发行走，升级即生效；升级会把 `app.env` 里冻结的旧默认删掉（原文件在 `backups/` 留一份）。只有要覆盖时才设 `VIBETERM_STUN_SERVERS`，设成 `none` 表示关闭 STUN。`vibeterm doctor` 会告诉你当前生效的是哪一种。
- **僵尸连接几秒内就能发现。** 手机从后台回来时，一条已经悄悄死掉的连接此前最长要一分半才会被换掉。现在每次回到前台都会按实测往返时延发一次带期限的探测，超时立刻重连——快链路约 2 秒，慢链路约 3 秒。

### 改进

- **慢速移动网络下的冷启动快了约三倍。** 在 400 ms 往返 / 2 Mbps 下实测，首个终端画面从 21.7 秒降到 7.4 秒，出画面前需要的字节从 4.8 MB 降到 0.8 MB。三件事叠加：脚本、样式与 WebAssembly 改为预压缩下发（brotli / gzip）；终端默认字体拆成两段，首帧只等 45 KB 的拉丁子集而不是 1.2 MB 的完整字体（完整字体在首屏之后加载并整屏重绘）；语言包只下当前真正用到的那一门。
- **超时按链路自适应，不再按局域网拍脑袋。** 拨号、转发与请求的期限都由实测往返时延推出，800 ms 之外的节点不会在还在应答时就被判定不可达；局域网行为不变。仅仅是超时的地址最多退避 5 分钟（拒绝 / 不可达仍退避数小时），任一地址拨通即清空该节点的全部退避。
- **手机上的应用会自己更新了。** iOS 主屏 PWA 此前会一直停在添加那天的版本：新的应用外壳要等所有旧页面退出才生效，而手机上这永远不会发生。现在它会在安全时刻（页面加载，或在后台待够 30 秒后回到前台）接管并刷新一次。弱网 / 省流量时不再预缓存那 7.5 MB 的懒加载分片，等链路转好再补装。
- 直连协商不再在会话尚未建立时就开跑（此前每台远端节点、每次连接都要白打几次必然 404 的请求）；`/api/rtc/authorize` 失败改为按节点退避，不再原地重试。
- 回到前台不再触发一批 REST 请求：只有设备列表会在获得焦点时刷新，且仍遵守 60 秒的新鲜期。多节点事件流也会把首屏让给终端，并在静默 30 秒后换一条连接。
- 连接详情浮层改为独立图层渲染，手机上（包括键盘弹出时）始终留在可见区域内。

### 修复

- hub / 中继显式撤回 TURN 配置时现在会被尊重：节点不再回落到自己本机的 TURN 设置。
- hub 下发空 STUN 列表的含义是「我没有自定义列表」，不是「关掉 STUN」：节点继续用内置列表。
- Service Worker：首次安装不再被误判成换版本，页面不会无缘无故刷新一次。
- 启动时仍被锁住的语言在解锁后能真正加载（此前会一直显示裸 key，直到整页重载）。

### 升级说明

- **STUN 变更与首屏合并只有在 hub 与全部节点都升到 2.2.0 后才生效。** 混合版本照常工作——每条链路各自回落到旧行为。
- **手机上的 PWA 会自己刷新一次**，就在升级后第一次把它切回前台的时候。这是上面说的换代接管，不是崩溃。
- 发行包体增大约 4 MB（静态资源的预压缩副本）。

---

