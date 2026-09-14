# 站点名 / 访问地址与 mesh 节点身份联动

本文描述加入 mesh 后站点名与访问地址如何托管给节点身份：`GET/PATCH /api/settings/site` 的联动字段、写保护与双向同步；面向改动站点设置与节点改名的开发者。

## 背景

站点名与访问地址存在 `site_settings` 单行（`site_name` / `site_url`），首次由 `VIBETERM_SITE_NAME` / `VIBETERM_BASE_URL` 播种，之后 env 不再覆盖。加入 mesh 后站点名有了第二个真源：显示名来自本机节点身份（`node_identity.name` / `rename-node` 投影），通知、分享深链还需要一个公网能点开的访问地址。standalone 行为完全不变。

mesh 下站点名托管给节点身份：设置页改名走密钥日志 `rename-node`，反向由 `node.list` / `relay.list` 同步回本地 `site_settings`。访问地址在中继上联下**可编辑**（用户可以填自己的公网域名）；未填公网地址时展示 `<中继公开地址>/n/<self>`。

## 契约

站点设置字段的单一真源是 `@vibeterm/shared` 的 `SITE_SETTING_FIELDS`（`packages/shared/src/contracts/site-settings.ts`）：每条含 `key` / `kind`（`string` | `bool` | `int` | `secret` | `enum` | `strings`）/ `default` / `cliFlag` / `patch`，以及校验用的 `min` / `max` / `trim` / `httpUrl` / `values` / `errorKey`。`SiteSettings` / `UpdateSiteSettingsRequest`、PATCH 归一化、gateway merge、CLI `SITE_KEYS` 与 USAGE 行均从该表派生。`theme` 的 `patch: false`，只走 WS / `updateSiteSettings({ theme })`，不进 PATCH / CLI `site set`。新增字段：改 registry + 手写 drizzle 列 + 迁移。

`GET /api/settings/site` 与 `PATCH /api/settings/site` 的 2xx 响应带四个联动字段（同时出现在响应顶层与 `settings` 上，见 `SiteSettingsLinkFields`）：

```ts
{
  settings: SiteSettingsView,        // settings.siteUrl 已是有效访问地址
  effectiveSiteUrl: string | null,   // 与 settings.siteUrl 相同
  siteUrlEditable: boolean,          // 中继上联为 true；未注入托管时为 true
  siteNameLinkedToNode: boolean,     // mesh（node 角色）为 true
  nodeId: string | null              // mesh 为本机 node id
}
```

接线在 `mesh/effective-site-url.ts` 的 `createMeshSiteSettingsLink`：

| 模式 | `siteUrlEditable` | `siteNameLinkedToNode` | `settings.siteUrl` |
| --- | --- | --- | --- |
| standalone | `true` | `false` | 存储的 `site_url` |
| node（未挂中继） | `true` | `true` | 存储的 `site_url` |
| node（中继上联） | `true` | `true` | 存储值若已是公网地址则用它，否则 `<中继公开地址>/n/<self>` |

中继入口地址由装配层注入 `relayAccessUrl`（当前挂上的中继公开地址 + `/n/<self>`）。存储值是否「公网地址」走 `normalizeShareOrigin` / `isPublicShareOrigin`：种子回环地址不算，退回中继入口。有效地址是 overlay，不改存储行。

`siteUrlManaged()` 在中继上联下恒为 `false`（`createMeshSiteSettingsLink`），因此 `PATCH` 可以改 `siteUrl`。未显式传入 `siteUrlManaged` 的旧调用方退回 `linked()`，那种接线才会把 URL 标成只读。

### 写保护

mesh 下 `PATCH` 携带**与当前有效值不同**的站点名直接 400；站点 URL 仅在 `siteUrlManaged() === true` 时同样拒绝：

| 请求字段 | 响应 |
| --- | --- |
| `siteUrl` 与有效地址不同，且 URL 被托管（比较时 trim 并去掉尾部 `/`） | `400 { error: 'site_url_managed' }` |
| `siteName` 与当前站点名不同（trim） | `400 { error: 'site_name_managed' }` |

值相同或省略则忽略该字段，同一请求里的其它设置照常保存——所以表单可以整包回写，不必先做差分。这两个是机器码，不是 i18n key。中继上联下改站点 URL 会写入存储行，之后优先于中继入口展示。

改名请走密钥日志 `rename-node`（`POST /api/auth/keylog`，查询名 `?hub=sync` 是冻结别名）。`nodes.name` 的投影来自这条记录，不是独立的 rename HTTP。

### 同步方向

- **`rename-node` → 本地**：记录应用到本机 node id 时写 `site_name`，并广播 `settings` 更新。
- **`relay.list` / peer `node.status` → 本地**：节点每次收到含本机行的名册，名字与本地不同就写库（相同则不写，幂等）。首次加入 mesh 时以名册为准。
- **有效地址**：不落库。`getSiteSettings()` 在 mesh 下把 `siteUrl` overlay 成有效地址，存储行保持不变，因此通知、pane 链接、PWA manifest 等消费方自动跟随，无需各自改造。

## 前端

「设置 → 通用」在 mesh 下：站点名输入框提交时改调 `rename-node`；访问地址在中继上联下可编辑，未填公网域名时只读展示 `effectiveSiteUrl`（`<中继>/n/<self>`）；保存只提交实际改动过的字段。

## 注意

- **TOTP issuer 不随站点名变**：`totpOtpauthUri()` 的 issuer 硬编码为 `vibeterm`，改名不会让验证器 App 里已有的条目改标签，也不需要重新绑定。
- 存储的 `site_url` 在 standalone 下就是访问地址；mesh 下它是用户配置的公网地址（若有），否则只是最后一层兜底，不要拿种子回环地址当「用户配置的地址」来读。
- 中继未探通（`relayAccessUrl` 为 null）且存储值不是公网地址时，有效地址回退到存储值，页面可能显示一个回环地址——这是提示运维补公网域名或等中继上线，不是 bug。
