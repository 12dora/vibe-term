# 发行包签名（Ed25519）

本文描述发行包的离线验签体系：密钥与轮换、CI 签名步骤、各校验点、三条不变量与兼容矩阵；面向发版维护者与改动升级链路的开发者。

## 背景与威胁

节点升级有两条来源：

1. 节点自己从 GitHub Releases 下载 `vibeterm-cli-<version>.tgz`；
2. 入口 / hub 下载完之后把整包**推**给节点（`PUT /api/system/upgrade/package`），节点暂存后再装。

第二条路若只靠推包方在 query 里自报的 `sha256`，坏包配坏摘要一样对得上——入口或 hub 一旦被攻陷，就能给 mesh 里每一个节点
装任意代码。很多节点在内网 / 离线，不能指望它们联网去问「这个包是不是真的」。

结论：校验必须在**本地、离线、不依赖任何在线服务**的前提下完成，唯一可行的形态是
「发布私钥签名 + 客户端内嵌公钥验签」。

## 密钥与轮换

- 算法 Ed25519，签的是 `SHA256SUMS` 的**原始字节**（含末尾换行），一个字节都不能差。
- 公钥内嵌在 `packages/shared/src/release/release-signing.ts` 的 `RELEASE_SIGNING_KEYS`：

  ```ts
  export const RELEASE_SIGNING_KEYS: readonly ReleaseSigningKey[] = [
    { id: 'r1', publicKey: 'x3aihYJPAJ6OafKJ/W5QHGX1IA4n61WD650sQaMl3OY=' },
  ];
  ```

- 私钥（raw 32 字节种子的标准 base64）只存在两处：GitHub Actions secret `VIBETERM_RELEASE_SIGNING_KEY`，
  以及维护者自己保管的离线备份 `~/code/key/tmex-release-signing-ed25519-r1.json`（文件名沿用改名前的写法，未改；
  `{"seedB64":"<base64>","pubB64":"<base64>"}`，权限 0600）。除此之外任何地方都不该出现，包括日志、CI 输出、仓库。

**轮换步骤**（追加，不是替换）：

1. 生成新种子与公钥，把 `{ id: 'r2', publicKey: '<新公钥 base64>' }` **追加**到 `RELEASE_SIGNING_KEYS` 末尾，
   旧条目原样保留；
2. 合并并发一个版本，让带新公钥的客户端先铺开；
3. 把 secret `VIBETERM_RELEASE_SIGNING_KEY` 换成新种子，之后的发版就由 `r2` 签；
4. 只有当确认「不再需要验证 `r1` 签过的任何版本」时，才从数组里删掉 `r1`。

签名脚本会用种子推出公钥，在 `RELEASE_SIGNING_KEYS` 里找不到就直接失败——防止签出一把谁也验不了的钥。

## 流水线

`.github/workflows/release.yml` 在 `shasum` 之后多一步：

```yaml
- name: Sign SHA256SUMS
  env:
    VIBETERM_RELEASE_SIGNING_KEY: ${{ secrets.VIBETERM_RELEASE_SIGNING_KEY }}
  run: |
    bun scripts/release/sign-sums.ts packages/app/SHA256SUMS
    cat packages/app/SHA256SUMS.sig
```

`scripts/release/sign-sums.ts` 读 secret、签名、**自验一遍**再写 `packages/app/SHA256SUMS.sig`；
secret 缺失、种子不是 32 字节、公钥不在钥表里、自验不过，任何一种都 `exit 1`，不会发出一个验不过的 release。
`SHA256SUMS.sig` 与 `vibeterm-cli-<version>.tgz`、兼容资产 `tmex-cli-<version>.tgz`、`SHA256SUMS` 一起作为 release 资产上传（create 与 edit 两条分支都传）。

`SHA256SUMS` 从 2.0.0 起有**两行**：改名后的 `vibeterm-cli-<version>.tgz` 与内容等价、`package.json.name` 改回 `tmex-cli` 的兼容资产 `tmex-cli-<version>.tgz`（`scripts/release/build-legacy-asset.ts` 生成）。两行进同一份 `SHA256SUMS`，由同一把私钥签一次，所以新旧节点验的是同一个签名。留兼容资产的原因见 [发布流程](./release-process.md#兼容资产-tmex-cli-versiontgz)：≤ 1.1.40 的节点只会按旧文件名找摘要、只认 `package.json.name === 'tmex-cli'`。全网升到 2.0.0 之后的某个版本删掉这一行。

签名文件只有一行：

```
tmex-release-sig v1 <keyId> <base64(64 字节签名)>
```

字段以单个空格分隔，多余字段一律判为 malformed。行首标记 `tmex-release-sig` 是协议常量，沿用 tmex 时期的值：1.1.39+ 的节点按这个字面量解析签名文件，改了它等于让所有现网节点的验签直接 malformed。

## 校验点

| 位置 | 代码 | 行为 |
| --- | --- | --- |
| 入口 / 节点下载发行包 | `apps/gateway/src/system/release-download.ts` → `fetchVerifiedReleaseSums()` | 并行取 `SHA256SUMS` 与 `SHA256SUMS.sig`，本地验签后再用签名里的摘要比对整包；缓存包也带 `.sig.json` sidecar，命中缓存时重新验一遍 |
| 入口推包给节点 | `apps/gateway/src/system/remote-upgrade-job.ts` | 下载结果没有签名 → 作业直接 `RELEASE_UNSIGNED` 失败；推字节之前先 `POST /api/system/upgrade/package/manifest`，目标 404（老节点）才继续 |
| 节点收清单 | `apps/gateway/src/system/upgrade-manifest.ts` | 用内嵌公钥验签，并确认 `SHA256SUMS` 里确实列了对应资产（`vibeterm-cli-<version>.tgz`，兼容期同时接受 `tmex-cli-<version>.tgz`），通过后落成 sidecar |
| 节点收字节 | `UpgradeController.stagePackage()` | 该版本已有清单时，query 的 `sha256` 必须等于清单里的摘要，否则 409 `UPGRADE_MANIFEST_MISMATCH` |
| 节点装包 | `UpgradeController.tryStart({ source: 'staged' })` | 没有可验签的清单、或清单摘要与盘上暂存包不符 → `UPGRADE_SIGNATURE_REQUIRED`，**没有任何 env 开关可以绕过** |
| 远程发起的升级 | `POST /api/system/upgrade`（`api/system.ts` 判定是否经由别的节点转发） | 从别的节点转发进来的升级，目标版本必须 ≥ `RELEASE_SIGNING_SINCE`，与 `source` 无关；否则 409 `UPGRADE_SIGNATURE_REQUIRED` |
| CLI 升级 | `packages/app/src/lib/upgrade-verify.ts` → `assertReleaseSignature()` | 与入口同一套版本门槛 |

三条不变量：

- **推来的包，没有可验签的清单就永远装不上。** 被攻陷的入口能做的最多是浪费节点的带宽和磁盘。
- **签名坏了永远拒绝**，不因为版本老而放行；只有「完全没有签名」才享受版本兼容。
- **降级也关死**：缺签名的历史版本只留给本机操作者（本机 CLI、未经转发的本地请求）。否则被攻陷的
  入口可以让能上网的节点先自下载一个还没有验签逻辑的老版本，再往那个版本推任意代码——两步就绕开了
  整条信任链。判定用的是「请求是不是从别的节点转发进来的」（dispatch 上下文的 `viaNodeId` /
  `clientIp` 的 `peer:` 前缀），不是 `source` 字段。

清单 sidecar 落在 `<installDir>/staging/staged/vibeterm-cli-<version>.manifest.json`，比字节先到，
因此孤儿清理要放它一马；删暂存包 / 淘汰旧版本 / 装包消费时一起删。

清单的生命周期有一个容易踩的坑：暂存包超过 24 小时没人装就会过期，而重试是「先交新清单、再重推字节」。
所以**过期清理绝不碰清单**——否则刚收到的新清单会被上一轮的过期清理连带删掉，重传能成功但装包必然
`UPGRADE_SIGNATURE_REQUIRED`，而发送方一个任务只交一次清单，恢复不了。清单按自己 JSON 里的
`createdAt`（与暂存记录同一把可注入的时钟，不看文件 mtime）在孤儿清理里过期；过期暂存包的删除改为
同步执行，避免 fire-and-forget 跑到重试新写的 sidecar 后面去。

回包一律有界读取（`consumeBoundedBody`）：`withTimeout()` 只管到拿到 `Response` 为止，对端把头发完
再把 body 吊住，就能让升级作业永远停在那里并一直占着发行包缓存租约；灌一个超大 body 则吃内存。
清单交付用同一份预算覆盖「发请求 + 读回包」，超时或超量都立刻 cancel 读流。

## 兼容矩阵

`RELEASE_SIGNING_SINCE = 1.1.39`：这一版起的 release 才有 `SHA256SUMS.sig`。

| 场景 | 目标版本 < 1.1.39 | 目标版本 ≥ 1.1.39 |
| --- | --- | --- |
| 入口 / 节点自升级下载 | 允许没有 `.sig`（老 release 本来就没有）；有 `.sig` 就必须验得过 | 必须有且验得过，否则 `RELEASE_UNSIGNED` |
| 入口推包给节点 | 不允许：没有签名的包一律不推 | 正常 |
| CLI `vibeterm upgrade` | 同「自升级下载」 | 同「自升级下载」 |
| 老节点（无 `signed-package` 能力） | 清单 POST 收到 404，入口按老流程推包；老节点自己仍只认自报 sha256 | 同左 |
| 老入口推包给新节点 | 新节点没收到清单 → 字节能落盘，但装包一步 `UPGRADE_SIGNATURE_REQUIRED` | 同左：升级不会完成，需要先把入口升到 1.1.39+ |

节点通过 `SystemInfo.upgradeCapabilities` 里的 `'signed-package'` 宣告自己支持清单接口。

`install.sh`（首次安装的 shell 脚本）**未**接入签名校验：shell 里没有可依赖的 Ed25519 实现，
它仍然只校验 SHA256SUMS。首次安装本来就要信任下载源，风险面与「已装机的节点被推包」不同。

## 验收

1. `bun test packages/shared/src/release/` — 签名往返、篡改、错钥、非法签名行；
2. `bun test apps/gateway/src/system/` — 清单接口、暂存摘要不符、缺清单装包被拒、入口推包带清单、
   老节点 404 回落、远程降级被拒、过期后重试（含控制器重启）、回包挂住 / 超大回包；
3. `bun test packages/app/src/lib/upgrade-verify.test.ts` — CLI 版本门槛；
4. 发版后人工确认 release 资产里有 `SHA256SUMS.sig`，且
   `bun -e "..."`（或直接跑一次 `vibeterm upgrade`）能验过。
