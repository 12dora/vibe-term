# 2.6.2

_2026-09-15_

## English

### Fixes

- Service: the gateway now watches its own main thread. If the process is still alive but stops responding (for example when the built-in WebRTC library deadlocks on a TURN-relayed connection, which froze the Shanghai relay for hours), the service ends itself within about 30 seconds and the system service manager starts it again automatically. Previously such a freeze looked "running" and stayed down until someone restarted it by hand. Laptop sleep, clock changes and a slow first start after an upgrade do not trigger it. Each restart is recorded in `loop-watchdog.log` in the install directory; the watchdog can be tuned or turned off with the `VIBETERM_LOOP_WATCHDOG*` settings.
- `vibeterm doctor`: when the service is running but the health endpoint does not answer, doctor now reports a failure (exit code 1) with recovery steps instead of a warning, and shows the most recent watchdog restart if there was one.

---

## 中文

### 修复

- 服务：网关现在会监视自己的主线程。进程还在但完全不响应时（例如内置 WebRTC 库在走 TURN 中继的连接上死锁，此前曾让上海中继挂死数小时），服务会在约 30 秒内自行退出并由系统服务管理器自动拉起。以前这种卡死会一直显示「运行中」，只能人工重启。笔记本休眠、系统时间调整、升级后首次启动较慢都不会误触发。每次重启都会记录到安装目录的 `loop-watchdog.log`；可用 `VIBETERM_LOOP_WATCHDOG*` 配置调整阈值或关闭。
- `vibeterm doctor`：服务在运行但健康接口无响应时，doctor 现在按失败（退出码 1）报告并给出恢复步骤，而不再只是警告；若看门狗最近重启过服务也会一并显示。
