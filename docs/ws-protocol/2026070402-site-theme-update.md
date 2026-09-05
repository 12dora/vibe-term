# KIND_SITE_THEME_UPDATE：站点主题广播协议

> 日期：2026-07-04
>
> 关联任务：Task 10（WS 主题广播协议 + 服务器 timestamp last-writer-wins）

## 背景

tmex 支持多端同时连接同一 gateway（桌面 + 手机 + 平板）。用户在任一端切换主题时，所有端需在 <1s 内同步。早期方案靠一条 HTTP 路由写库 + 前端轮询，延迟高且无实时保证；该路由已下线，站点外观的上行与广播只剩本文这一条 WS 通道。

## 设计思路

新增 ws-borsh kind `KIND_SITE_THEME_UPDATE`（0x0801），走 C2S→S2C 广播模式：

1. 客户端发 C2S（仅 theme 枚举值，不带 timestamp）
2. 服务端校验 → `Date.now()` 分配 serverTimestamp → 写 SiteSettings DB → 更新内存 currentTheme → 触发 window-style 更新（T8）+ 主题通知注入（T9）→ 广播 S2C 给所有已连接 ws clients（含发送方）
3. 客户端收 S2C → 调 `useSiteStore.setThemeFromS2C()` → **不回送 C2S**（避免循环）

### last-writer-wins

服务器串行处理 WS 消息，`serverTimestamp` 严格递增（同毫秒内并发时 +1ns 保证唯一）。最后到达的请求胜出，覆盖 DB 和内存状态。

### kind 编号选择

新增 0x0800 段「站点设置」。0x0300 段已被终端数据占用，0x0200 段已被 tmux 控制占用。0x0801 为该段首个 kind。

## payload schema

### C2S（0x0801）

```borsh
struct SiteThemeUpdateC2S {
  theme: u8,  // 0=dark, 1=light
}
```

不带 clientTimestamp，避免多端时钟漂移导致顺序错乱。

### S2C（0x0801，同 kind 双向）

```borsh
struct SiteThemeUpdateS2C {
  theme: u8,           // 0=dark, 1=light
  serverTimestamp: u64, // 服务端 Date.now() 分配，bigint
}
```

## 前端监听

解码在 `packages/ws-client/src/transport-message-decoder.ts`，分发在 `packages/stores/src/tmux-event-router.ts`：

- 收到 `KIND_SITE_THEME_UPDATE` 后调 `useSiteStore.getState().setThemeFromS2C(theme)`（`packages/stores/src/site.ts`）。
- `setThemeFromS2C` 是专门的入口：它写入主题但**不触发**回送 C2S 的副作用，从源头断开循环，而不是靠调用点自觉不回送。

主题变化时向所有已连接设备发 `KIND_TMUX_SET_WINDOW_STYLE` 的监听器保持不变，这是期望行为（同步 tmux window-style），不构成循环。

## gateway handler

`apps/gateway/src/ws/theme-settings-broadcaster.ts` 的 `handleSiteThemeUpdate`（经 `apps/gateway/src/ws/index.ts` 委派）：

1. 校验 `theme ∈ {0, 1}`，非法值返回 ERROR
2. `Date.now()` 分配 serverTimestamp，保证严格递增
3. `updateSiteSettings({ theme })` 写库
4. `handleSiteThemeChange(theme)` 触发 T8 window-style 更新
5. `broadcastThemeChange(theme)` 触发 T9 stdin 注入
6. 广播 S2C 给 `connectedClients`（全局客户端集合，含发送方）

## 覆盖

单测覆盖 borsh round-trip、广播路由与并发 last-writer-wins；主题跨端同步另有 e2e
（`apps/fe/tests/theme-propagation.spec.ts`）。
