# 应用级错误边界与面板级兜底

## 背景

路由没有 `errorElement`，侧滑面板宿主又是裸 `React.lazy` + `Suspense`，任何渲染异常或 chunk 加载失败都会掉到 React Router 的默认页：「Unexpected Application Error! … 👋 Hey developer 👋」。这张页面是给开发者看的，用户拿到它既不知道发生了什么，也没有任何恢复手段。

## 结构

`apps/fe/src/components/app-error-boundary.tsx` 提供一套文案与详情块，两种形态：

| 形态 | 挂在哪 | 行为 |
| --- | --- | --- |
| `page` | 根路由的 `errorElement`（`RouteErrorElement`，`main.tsx` 顶层无路径父路由，子路由继承） | 整页替换。按钮：重试 / 重新加载 / 回首页 |
| `panel` | `SidePanelHost` 的面板内容外层（`AppErrorBoundary variant="panel"`） | 只毁面板这一块，页面其余部分照常可用。按钮：重试 / 关闭面板 |

卡片内容：标题 + 说明 + 可折叠的错误详情（错误信息、调用栈、版本、当前地址），带一键复制，方便用户把现场发回来。文案在 `appError.*`。

细节：

- `AppErrorBoundary` 重试时递增内部 `attempt` 并用它当 `key`，子树整棵重挂，而不是复用已经出过错的实例。面板边界另外带 `key={panel}`：换面板等于换内容，上一块的错误不留给下一块。
- `RouteErrorElement` 的重试是重新导航到当前地址（data router 在导航完成时清错误状态）；`page` 形态的「回首页」走整页跳转而非 client navigate——出错的往往正是被渲染的那个模块，客户端跳转只会把同一份坏状态再挂一次。
- `describeError` 兼容 `isRouteErrorResponse`（`<status> <statusText>`）、`Error`、字符串与任意值。

## 懒加载 chunk 的重试

面板改用 `lazyChunk()`（`apps/fe/src/lazy-chunk.tsx`）而不是裸 `React.lazy`。原因是 `React.lazy` 会把 reject **永久缓存**成 Rejected 并在每次渲染时抛出，发版后旧 chunk 404 就是白屏。

`lazyChunk` 在 loader 里就地把失败换成重试卡片：

- 重试重新走一次 `import()`；成功的模块按 loader 记进 `RECOVERED`，切走再切回来不会又看到重试卡片。
- 失败次数按 loader 累计，卸载重挂不清零；达到 `MAX_CHUNK_RETRIES = 2` 后重试按钮改成整页刷新——浏览器会把失败的模块 URL 记进 module map，只有重新拿一次 `index.html` 才能指向新版 chunk。
- 进行中的重试不重复发起。

## 测试锚点

`data-testid`：`app-error` / `panel-error`、`app-error-retry`、`app-error-reload`、`app-error-home`、`app-error-close`、`app-error-details-toggle`、`app-error-details`、`app-error-copy`、`app-error-version`。

`AppErrorBoundary.retry` 是 public 方法，单测可以直接驱动这条状态迁移（服务端静态渲染下点不到按钮）。
