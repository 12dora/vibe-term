# 前端包结构与嵌入用法

## 背景

`apps/fe` 原为单体 React 应用，业务逻辑（stores、WS 客户端、REST 客户端、终端组件、
业务面板）与外壳（路由、布局、i18n 装配）耦合在一起。为便于按领域复用与在多实例宿主中
嵌入，前端按依赖方向拆为多个 workspace 包，`apps/fe` 退化为薄外壳。

## 包结构

根 `package.json` 的 workspaces 为 `apps/*` + `packages/*`。`packages/` 下共 11 个包，其中 10 个属前端/共享层，`packages/app`（npm 包名 `tmex-cli`）是 Node 兼容的安装/升级 CLI，不参与前端依赖图（见 `packages/app/README.md`）。

| 包 | 目录 | 职责 | 出口 |
|---|---|---|---|
| `@tmex/shared` | `packages/shared` | 跨端共享：ws-borsh schema、i18n 资源、类型、capabilities 常量 | `.`、`./i18n/resources`、`./i18n/types`、`./i18n/locales/*`（含 `manifest.json` 与 en_US/zh_CN/ja_JP） |
| `@tmex/ui` | `packages/ui` | shadcn/base-ui 原子组件、`cn`、`useIsMobile` | `.`、`./*`（每个原子组件一个子路径） |
| `@tmex/ws-client` | `packages/ws-client` | Borsh WebSocket 客户端、PaneSink 注册表、Select 状态机、history 门控、连接工厂 | `.`、`./*` |
| `@tmex/api-client` | `packages/api-client` | REST 客户端（`ApiClient`）、端点函数、`FeatureSet`、分块上传/下载 | `.`、`./*` |
| `@tmex/notifications` | `packages/notifications` | 通知/铃声语义接口与文案组装 | `.`、`./*` |
| `@tmex/theme` | `packages/theme` | 主题 token、themes.css、字体清单与 woff2 产物、preset 激活 | `.`、`./fonts`、`./fonts/manifest`、`./fonts/types`、`./themes.css`、`./tokens.css`、`./tokens.generated.css`、`./resources/fonts/*`、`./*` |
| `@tmex/stores` | `packages/stores` | zustand store 工厂 + 应用运行时工厂 | `.`、`./*`、`./react` |
| `@tmex/terminal-ui` | `packages/terminal-ui` | 终端组件、分屏、触控/键盘/尺寸逻辑 | `.`、`./terminal-diagnostics`、`./*` |
| `@tmex/panels` | `packages/panels` | 业务面板 | `.`、`./agent`、`./files`、`./markdown`、`./code-viewer`、`./watch`、`./settings`、`./device-tree`、`./device-console`、`./device-management` |
| `ghostty-terminal` | `packages/ghostty-terminal` | Ghostty wasm 终端底座（**独立发布到 npm，非 `@tmex/` 作用域**），Canvas 渲染、鼠标/输入编码、headless 模拟器 | `.`、`./headless` |

依赖方向（无环）：

```
shared ─→ ws-client ─┬─→ api-client ─┐
                     ├─→ notifications ┼─→ stores ─┬─→ terminal-ui ─┐
                     └─→ theme ────────┘           │                ├─→ panels ─→ apps/fe
ui（无内部依赖）──────────────────────────────────→ terminal-ui / panels / fe
ghostty-terminal（无内部依赖）─────────────────────→ terminal-ui（含 gateway 的 headless emulator）
```

## 两层工厂：Connection 与 Runtime

嵌入的核心是两层工厂，均带全默认值——单实例宿主（开源 `apps/fe`）用默认单例零改动，
多实例宿主每个 gateway 连接组装一份。

1. **Connection 层**（`@tmex/ws-client`）：`createGatewayConnection({ wsUrl })` 返回
   `{ client, paneSinks, selectMachine }`，各绑定该连接自己的注册表/状态机。缺省时
   `getBorshClient()` 等原名导出绑定模块级默认实例，时序与拆包前一致。

2. **Runtime 层**（`@tmex/stores`）：`createAppRuntime(options)` 把连接面、REST 客户端、
   通知出口、宿主服务、`storagePrefix` 等组装成 `AppRuntime`（含五个 store 实例）。
   所有 option 有默认值；`defaultRuntime` 即缺省单例，`useTmuxStore` 等原名导出绑定它。

```ts
import { createAppRuntime } from '@tmex/stores';
import { createGatewayConnection } from '@tmex/ws-client';

const connection = createGatewayConnection({ wsUrl });
const runtime = createAppRuntime({
  connection,
  apiClient,              // 可注入自定义 baseUrl 的 ApiClient
  notifications,          // NotificationSink 实现（宿主提供 toast 适配器）
  host,                   // HostServices：navigate/isMobile/openMobileSidebar…
  storagePrefix: 'inst-1-', // 隔离 localStorage persist key（缺省空，与既有 key 一致）
});
```

## 组件如何取用 runtime

包内组件不直接引用默认单例，而经 `@tmex/stores/react` 的 context 便捷 hook 取用，
缺省 context 值即 `defaultRuntime`（故开源 fe 无需 Provider）：

```tsx
import { RuntimeProvider, useTmuxStore, useRuntime } from '@tmex/stores/react';

// 多实例宿主：每个实例子树包一层 Provider
<RuntimeProvider runtime={runtime}>
  <DeviceView />
</RuntimeProvider>;

// 组件内：
const snapshots = useTmuxStore((s) => s.snapshots);
const runtime = useRuntime();
runtime.notifications.success('done');
```

## 子路径出口

`@tmex/ui` 与 `@tmex/panels` 按组件/领域提供子路径出口以保持代码分割：

- `@tmex/ui/button`、`@tmex/ui/dialog` …（每个原子组件一个子路径）
- `@tmex/panels/agent`、`/files`、`/settings`、`/markdown`、`/code-viewer`、`/watch`、`/device-tree`、`/device-console`、`/device-management`
- `@tmex/panels`（根出口）：轻量状态指示组件（连接指示、设备状态徽标）

设置面板全量出口（`@tmex/panels/settings`）为纯再导出桶，消费方按 featureset 决定渲染
哪些 tab；打包时 rollup 按名摇树，只取用的 tab 及其子图进入对应 chunk。

## capabilities 与 featureset

服务端能力集有两处来源，同源于 `GATEWAY_CAPABILITIES`：

- WS `HELLO_S2C` 的 `capabilities` 字段 → `BorshWebSocketClient.serverCapabilities`（按连接）
- REST `GET /api/capabilities` → `fetchCapabilities()` → site store 的 `capabilities: FeatureSet`

消费方经 `FeatureSet.has()/hasAll()/hasAny()` 判定是否渲染某功能面。
