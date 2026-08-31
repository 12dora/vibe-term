# 设置页各 tab 加载慢的根因与处置

## 根因（见 prompt-archives/2026083101-onboarding-remote-access-round8/sub/E5-result.md）

- 远程访问：`GET /api/tunnel/status` 同步等待外部隧道检测——`ps`、launchd/systemd 目录扫描、cloudflared 配置读取、多次串行 Cloudflare API（隧道名/ingress/Access `listApps` 最多 50 页），且无超时；30s 缓存过期即整段重跑。
- 多节点互联：整页等 `/api/auth/mode`（每次重算 TLS 信息、主用户扫描）；`/api/local/status` 串行等本机状态再等 TLS 解析。
- 其余 tab 主要是懒加载 chunk 与 5s staleTime 导致的重复请求；终端 tab 预览同步初始化 Ghostty；通知 tab 静态引入 qrcode。

## 处置

后端：外部检测 stale-while-revalidate（`external-detect.ts`：过期先返旧值、单飞后台刷新、冷启动最多等 1.5s 返 `probing:true`，`force` 供 adopt/sync），启动预热不阻塞；Cloudflare 请求 3s 超时、`listApps` 6s 总预算（截断→unknown，绝不当「未覆盖」）；`/api/local/status` 并行；`TlsService.status()` 10s 投影缓存随写操作失效；`/api/auth/mode` 与请求无关部分 5s 缓存（passkey 标志按 origin 实时），本机登录开关/引导、key-log apply、`setTlsInfo`/`setLocalAuthStore` 失效。

前端：悬停/空闲预取 tunnel/local/tls 状态（`status-queries.ts` 共享 key/fetcher）；只读设置数据 `SETTINGS_STALE_MS=30s`；终端预览 lazy + 等高骨架；节点页骨架屏；微信登录弹窗与 qrcode 按需加载。

## 遗留

- `admit/revoke`、hub enrollment 等 `UserStore` 写路径未调用 `invalidateAuthModeCache()`，靠 5s TTL 兜底。
- 前端尚未消费 `external.probing`（可在远程访问页显示「检测中」）。
