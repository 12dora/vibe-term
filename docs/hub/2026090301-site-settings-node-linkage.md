# 站点名 / 访问地址与 mesh 节点身份联动

## 背景

站点名与访问地址存在 `site_settings` 单行（`site_name` / `site_url`），首次由 `TMEX_SITE_NAME` / `TMEX_BASE_URL` 播种，之后 env 不再覆盖。加入 mesh 后这两项就有了第二个真源：显示名的真源是 hub 的 `nodes.name`，访问地址的真源是 hub 公开地址（纯 node 还要带 `/n/<nodeId>` 前缀）。用户在「设置 → 通用」里改的值改不动真源，改完还会和节点管理页对不上。

本轮把 mesh 下的这两项托管给节点身份：设置页只读展示有效值，改名走 hub 的 rename 接口，反向由 hub 同步回本地 `site_settings`。standalone 行为完全不变。

## 契约

`GET /api/settings/site` 与 `PATCH /api/settings/site` 的 2xx 响应新增四个字段（同时出现在响应顶层与 `settings` 上，见 `SiteSettingsLinkFields`）：

```ts
{
  settings: SiteSettingsView,        // settings.siteUrl 已是有效访问地址
  effectiveSiteUrl: string | null,   // 与 settings.siteUrl 相同
  siteUrlEditable: boolean,          // mesh（hub 或 node）为 false
  siteNameLinkedToNode: boolean,     // mesh 为 true
  nodeId: string | null              // mesh 为本机 node id
}
```

| 模式 | `siteUrlEditable` | `siteNameLinkedToNode` | `settings.siteUrl` |
| --- | --- | --- | --- |
| standalone | `true` | `false` | 存储的 `site_url` |
| hub 角色（含 `hub,node`） | `false` | `true` | hub 公开地址 |
| 纯 node | `false` | `true` | `<hub 公开地址>/n/<nodeId>` |

有效 hub 公开地址的取值顺序（`mesh/effective-site-url.ts`）：writer hub 的 `publicUrl` → 当前挂靠 hub 的 `publicUrl` → `config.hubPublicUrl` → hub 元数据里的 `publicUrl`；全都拿不到时回退存储的 `site_url`。

### 写保护

mesh 下 `PATCH` 携带**与当前有效值不同**的字段直接 400：

| 请求字段 | 响应 |
| --- | --- |
| `siteUrl` 与有效地址不同（比较时 trim 并去掉尾部 `/`） | `400 { error: 'site_url_managed' }` |
| `siteName` 与当前站点名不同（trim） | `400 { error: 'site_name_managed' }` |

值相同或省略则忽略该字段，同一请求里的其它设置照常保存——所以表单可以整包回写，不必先做差分。这两个是机器码，不是 i18n key。

改名请走 `POST /n/<hub>/api/hub/nodes/<id>/rename`（hub 的 `nodes.name` 是真源）。

### 同步方向

- **hub → 本地**：hub `handleRename` 命中本机 node id 时回调 `updateSiteSettings` 写 `site_name`，并广播 `settings` 更新。
- **node.list → 本地**：节点每次收到含本机行的 `node.list`，名字与本地不同就写库（相同则不写，幂等）。首次加入 mesh 时以 hub 端为准。
- **有效地址**：不落库。`getSiteSettings()` 在 mesh 下把 `siteUrl` overlay 成有效地址，存储行保持不变，因此通知、pane 链接、PWA manifest 等消费方自动跟随，无需各自改造。

## 前端

「设置 → 通用」在 mesh 下：站点名输入框提交时改调 hub rename；访问地址一行只读展示 `effectiveSiteUrl`；保存只提交实际改动过的字段。

## 注意

- **TOTP issuer 不随站点名变**：`totpOtpauthUri()` 的 issuer 硬编码为 `tmex`，改名不会让验证器 App 里已有的条目改标签，也不需要重新绑定。
- 存储的 `site_url` 只在 standalone 下有意义；mesh 下它是最后一层兜底，不要拿它当「用户配置的地址」来读。
- hub 公开地址为空（既没配 `TMEX_HUB_PUBLIC_URL` 也没有 hub 行）时，纯 node 的有效地址会回退到存储值，页面可能显示一个过期地址——这是提示运维补 hub 公开地址，不是 bug。
- `auth-routes.ts` 里另有一份私有的 hub 选择逻辑，本轮未合并；它在「已有 writer 但 `publicUrl` 为空」时不会继续回退到 attached hub，与本文顺序略有差异。
