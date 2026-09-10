# development/

开发与测试约定、前端外壳行为、性能基准与实测 harness。

| 文档 | 内容 |
| --- | --- |
| [environments.md](./environments.md) | development / test / production 三套环境与 `loadEnv()`——起 dev server、写测试前必读 |
| [cli-architecture.md](./cli-architecture.md) | 客户端 CLI（`packages/cli`）的模块契约：命令组怎么加、ctx 形状、退出码、会话文件、与 packages/app 的接线 |
| [workspace-packages.md](./workspace-packages.md) | 前端 workspace 包结构、Connection / Runtime 两层工厂、嵌入用法 |
| [app-error-boundary.md](./app-error-boundary.md) | 路由 / 面板级错误边界、懒加载 chunk 重试 |
| [sidebar-node-first-paint.md](./sidebar-node-first-paint.md) | 冷启动侧栏节点首屏策略与前台拨号竞速 |
| [files-sidebar-visibility.md](./files-sidebar-visibility.md) | 文件侧栏可见性缺省与纵向拖拽 |
| [connect-devices-panel.md](./connect-devices-panel.md) | 「接入更多设备」面板与远程访问向导 |
| [font-pipeline.md](./font-pipeline.md) | 终端字体打包流水线 |
| [performance-hot-paths.md](./performance-hot-paths.md) | 热路径优化、基准脚本、Rust / WASM 评估 |
| [performance-frontend.md](./performance-frontend.md) | 前端流畅度、WS 重连、设置页加载、静态资源缓存 |
| [live-integration-tests.md](./live-integration-tests.md) | 打真实 endpoint 的实测约定 |
| [relay-live-harness.md](./relay-live-harness.md) | 中继三进程实测主管 |
| [hub-docker-e2e.md](./hub-docker-e2e.md) | Docker 多容器 hub/node 实测 harness |
