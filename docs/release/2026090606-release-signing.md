# 发行包签名（Ed25519）

## 背景与威胁

节点升级有两条来源：

1. 节点自己从 GitHub Releases 下载 `tmex-cli-<version>.tgz`；
2. 入口 / hub 下载完之后把整包**推**给节点（`PUT /api/system/upgrade/package`），节点暂存后再装。

第二条路在本轮之前只有一道校验：推包方在 query 里自报一个 `sha256`，节点收字节时按它算摘要。
摘要是推包方给的，坏包配坏摘要一样对得上——入口或 hub 一旦被攻陷，就能给 mesh 里每一个节点
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

- 私钥（raw 32 字节种子的标准 base64）只存在两处：GitHub Actions secret `TMEX_RELEASE_SIGNING_KEY`，
  以及维护者自己保管的离线备份 `~/code/key/tmex-release-signing-ed25519-r1.json`（`{"seedB64":"<base64>","pubB64":"<base64>"}`，
  权限 0600）。除此之外任何地方都不该出现，包括日志、CI 输出、仓库。

**轮换步骤**（追加，不是替换）：

1. 生成新种子与公钥，把 `{ id: 'r2', publicKey: '<新公钥 base64>' }` **追加**到 `RELEASE_SIGNING_KEYS` 末尾，
   旧条目原样保留；
2. 合并并发一个版本，让带新公钥的客户端先铺开；
3. 把 secret `TMEX_RELEASE_SIGNING_KEY` 换成新种子，之后的发版就由 `r2` 签；
4. 只有当确认「不再需要验证 `r1` 签过的任何版本」时，才从数组里删掉 `r1`。

签名脚本会用种子推出公钥，在 `RELEASE_SIGNING_KEYS` 里找不到就直接失败——防止签出一把谁也验不了的钥。

## 流水线

`.github/workflows/release.yml` 在 `shasum` 之后多一步：

```yaml
- name: Sign SHA256SUMS
  env:
    TMEX_RELEASE_SIGNING_KEY: ${{ secrets.TMEX_RELEASE_SIGNING_KEY }}
  run: |
    bun scripts/release/sign-sums.ts packages/app/SHA256SUMS
    cat packages/app/SHA256SUMS.sig
```

`scripts/release/sign-sums.ts` 读 secret、签名、**自验一遍**再写 `packages/app/SHA256SUMS.sig`；
secret 缺失、种子不是 32 字节、公钥不在钥表里、自验不过，任何一种都 `exit 1`，不会发出一个验不过的 release。
`SHA256SUMS.sig` 与 `tmex-cli-<version>.tgz`、`SHA256SUMS` 一起作为 release 资产上传（create 与 edit 两条分支都传）。

签名文件只有一行：

```
tmex-release-sig v1 <keyId> <base64(64 字节签名)>
```

字段以单个空格分隔，多余字段一律判为 malformed。

## 校验点

| 位置 | 代码 | 行为 |
| --- | --- | --- |
| 入口 / 节点下载发行包 | `apps/gateway/src/system/release-download.ts` → `fetchVerifiedReleaseSums()` | 并行取 `SHA256SUMS` 与 `SHA256SUMS.sig`，本地验签后再用签名里的摘要比对整包；缓存包也带 `.sig.json` sidecar，命中缓存时重新验一遍 |
| 入口推包给节点 | `apps/gateway/src/system/remote-upgrade-job.ts` | 下载结果没有签名 → 作业直接 `RELEASE_UNSIGNED` 失败；推字节之前先 `POST /api/system/upgrade/package/manifest`，目标 404（老节点）才继续 |
| 节点收清单 | `apps/gateway/src/system/upgrade-manifest.ts` | 用内嵌公钥验签，并确认 `SHA256SUMS` 里确实列了 `tmex-cli-<version>.tgz`，通过后落成 sidecar |
| 节点收字节 | `UpgradeController.stagePackage()` | 该版本已有清单时，query 的 `sha256` 必须等于清单里的摘要，否则 409 `UPGRADE_MANIFEST_MISMATCH` |
| 节点装包 | `UpgradeController.tryStart({ source: 'staged' })` | 没有可验签的清单、或清单摘要与盘上暂存包不符 → `UPGRADE_SIGNATURE_REQUIRED`，**没有任何 env 开关可以绕过** |
| CLI 升级 | `packages/app/src/lib/upgrade-verify.ts` → `assertReleaseSignature()` | 与入口同一套版本门槛 |

两条不变量：

- **推来的包，没有可验签的清单就永远装不上。** 被攻陷的入口能做的最多是浪费节点的带宽和磁盘。
- **签名坏了永远拒绝**，不因为版本老而放行；只有「完全没有签名」才享受版本兼容。

清单 sidecar 落在 `<installDir>/staging/staged/tmex-cli-<version>.manifest.json`，比字节先到，
因此孤儿清理要放它一马（只按保留期清），删暂存包 / 淘汰旧版本 / 装包消费时一起删。

## 兼容矩阵

`RELEASE_SIGNING_SINCE = 1.1.39`：这一版起的 release 才有 `SHA256SUMS.sig`。

| 场景 | 目标版本 < 1.1.39 | 目标版本 ≥ 1.1.39 |
| --- | --- | --- |
| 入口 / 节点自升级下载 | 允许没有 `.sig`（老 release 本来就没有）；有 `.sig` 就必须验得过 | 必须有且验得过，否则 `RELEASE_UNSIGNED` |
| 入口推包给节点 | 不允许：没有签名的包一律不推 | 正常 |
| CLI `tmex upgrade` | 同「自升级下载」 | 同「自升级下载」 |
| 老节点（无 `signed-package` 能力） | 清单 POST 收到 404，入口按老流程推包；老节点自己仍只认自报 sha256 | 同左 |
| 老入口推包给新节点 | 新节点没收到清单 → 字节能落盘，但装包一步 `UPGRADE_SIGNATURE_REQUIRED` | 同左：升级不会完成，需要先把入口升到 1.1.39+ |

节点通过 `SystemInfo.upgradeCapabilities` 里的 `'signed-package'` 宣告自己支持清单接口。

`install.sh`（首次安装的 shell 脚本）本轮**未**接入签名校验：shell 里没有可依赖的 Ed25519 实现，
它仍然只校验 SHA256SUMS。首次安装本来就要信任下载源，风险面与「已装机的节点被推包」不同。

## 验收

1. `bun test packages/shared/src/release/` — 签名往返、篡改、错钥、非法签名行；
2. `bun test apps/gateway/src/system/` — 清单接口、暂存摘要不符、缺清单装包被拒、入口推包带清单、老节点 404 回落；
3. `bun test packages/app/src/lib/upgrade-verify.test.ts` — CLI 版本门槛；
4. 发版后人工确认 release 资产里有 `SHA256SUMS.sig`，且
   `bun -e "..."`（或直接跑一次 `tmex upgrade`）能验过。
