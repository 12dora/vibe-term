# 文件侧栏：可见性缺省与竖向拖拽

## 背景

第十一轮实测里文件侧栏有两个问题：

1. **没开过开关的设备也出现在文件页**。`isSidebarFilesVisible()` 的缺省是「配了目录就显示」，
   本机与远端 node 一视同仁。hub 下挂若干 node 时，每台 node 自己配的目录会一股脑灌进文件树，
   而终端页的缺省（`isSidebarDeviceVisible()`）是「本机显示、远端隐藏」，两页行为不一致。
   同时，一个可见目录都没有的 node 仍会渲染一个空的分节头，几十台 node 就是几十行空标题。
2. **拖动根目录时整条侧栏往右滚**。`SortableVerticalList` 没有配 dnd-kit 的 `modifiers`，
   `useSortableRow` 直接套用 `CSS.Translate`（含 `x`），横向指针位移会把行推到一边；
   推出来的溢出让 Base UI `ScrollArea` 的 viewport（内联 `overflow: scroll`）横向可滚，
   dnd-kit 的自动滚动接着沿 X 轴滚它。

## 变更

### 可见性缺省

`packages/stores/src/sidebar-device-visibility.ts`：

```
isSidebarFilesVisible = stored ?? (runtimeNodeId === SELF_NODE_ID && hasRoots)
```

即与终端页对齐：只有 `self` 且配过目录的设备默认显示，远端 node 的设备一律默认隐藏，
用户在「管理设备」的设备卡片上逐台开启。**显式写入的值永远优先**（关掉本机、打开远端都照旧生效）。
设备卡片上的「文件」开关读的就是同一个函数，所以卡片状态与侧栏所见永远一致：远端设备配了目录时
开关可用但默认关。

`device.sidebar.filesHint` / `filesDisabledHint` 三语文案描述的仍是同一件事，未改动。

### 空分节不渲染

`packages/panels/src/files/files-node-roots.tsx` 抽出 `useVisibleFileRoots()`
（roots 查询 + 可见性过滤；同一个 QueryClient 下多处调用共用一份查询，不多打请求），
`FilesNodeSection` 的已登录形态据此决定整节渲不渲染：

- roots 查询还没落地：不渲染（避免分节头闪一下又消失）；
- 查询成功但可见目录为空：不渲染（连分节头都不出）；
- 查询失败：照常渲染，错误提示与重试按钮挂在分节里。

离线 / 未登录的分节不受影响——它们承载「节点离线」提示与登录入口。

### 竖向拖拽 + 只纵向滚动

- `packages/panels/src/device-tree/device-tree-dnd.tsx` 新增本地 `restrictToVerticalAxis`
  modifier（三行，不引 `@dnd-kit/modifiers`），挂在 `SortableVerticalList` 的 `DndContext` 上。
  被拖行不再横移，自动滚动的横向意图也随之归零；纵向自动滚动保持不变（未动 `autoScroll`）。
  设备网格与设备文件夹的 DnD context 不受影响。
- `packages/ui/src/components/scroll-area.tsx` 增加 `axis?: 'both' | 'vertical'`。
  `vertical` 时给 viewport **内联** `overflow: hidden scroll` + `overscroll-behavior-x: none`
  ——Base UI 把 `overflow: scroll` 写在内联样式里，class 赢不了它，只能用同一个简写属性覆盖。
  文件页（`files-tab.tsx`）与终端页（`device-tree/sidebar-device-list.tsx`）都改用 `axis="vertical"`；
  mesh 聚合的终端节点列表（`apps/fe/.../sidebar-device-list.tsx`）是普通 div，补
  `overflow-x-hidden overscroll-x-none`（只写 `overflow-y` 时 `overflow-x` 会由 `visible` 变成 `auto`）。

## 验收标准

- hub + 若干远端 node：文件页只显示本机目录，以及被显式打开的远端设备目录；没有可见目录的
  node 不出现分节头；设备卡片的「文件」开关与侧栏所见一致。
- 拖动根目录 / 节点分节：只能上下移动；侧栏 `scrollLeft` 始终为 0，`scrollWidth` 不超过
  `clientWidth`；纵向重排照常提交并落库。
- 单测：`packages/stores`、`packages/panels`、`packages/ui`、`apps/fe`（`bun test`）；
  e2e：`apps/fe/tests/files-sidebar-drag.spec.ts`。

## 注意事项

- 缺省规则变了但**存量偏好不变**：以前手动开关过的设备仍按存的值走。此前靠缺省显示的远端目录
  会消失，需要用户在「管理设备」里开一次——这是本次的预期行为。
- 静态渲染（`react-dom/server`）下 zustand 只读 `getInitialState`，改 store 或预写
  localStorage 都不生效，所以分节单测用 runtime 的 `nodeId` 表达「本机 / 远端」两种缺省。
