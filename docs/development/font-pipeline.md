# 终端字体打包流程

本文说明字体处理工具 `scripts/fonts/` 的用法与维护方式（精选清单、woff2 构建、动态 manifest、运行时懒加载）；面向要增删终端字体的开发者。

## 背景

终端与全应用等宽文本支持用户切换字体。字体从 [Nerd Fonts](https://www.nerdfonts.com/font-downloads) 精选，转成 woff2 随包分发，运行时按选中字体懒加载。

## 设计要点

- **真相源**：`scripts/fonts/fonts.config.ts` 维护精选清单（id / 展示名 / CSS family / Nerd Fonts 资产名 / 文件匹配前缀）。新增字体只在此追加一项。
- **动态 manifest**：构建工具扫描实际产物生成 `packages/theme/src/fonts/manifest.generated.ts`，前端选择器与懒加载据此消费，**不手写字体列表**。
- **整份转码不子集**：用 `wawoff2`（Google woff2 编码器的 WASM 封装）把整段 TTF/OTF 原样封装成 woff2，保留全部字形（含 Nerd 图标 PUA 区）。这一步不用 `subset-font`——实测它即便喂入全 codepoint 仍会裁掉不可达字形（retain-reachable 而非真正保留全部），而整份转码要的正是「一个字形都不能掉」。
- **默认字体另切 latin 子集**：`subset-font`（harfbuzz `hb-subset` 的 wasm 封装）在这里恰好是对的工具——要的就是「只留这批码位」。从**仓库已有的完整 woff2** 切，不重新下载资产。两个 `unicode-range` 由产物 cmap 反推、严格互补，不手写（手写必然与产物漂移）。详见下节。
- **缺字重自动跳过**：每个字体尝试定位 `Mono` 的 Regular + Bold；缺 Bold 即跳过并计入跳过报告，不进 manifest（故选择器只列真正可用的字体）。

## 用法

```bash
bun run build:fonts
```

流程：
1. 读 `fonts.config.ts`。
2. 逐字体从 Nerd Fonts pinned release（`NERD_FONTS_VERSION`，当前 `v3.4.0`）下载资产 zip，缓存到 `scripts/fonts/.cache/`（已 gitignore，重跑命中缓存）。
3. 解压，递归匹配 `<matchPrefix>NerdFontMono-{Regular,Bold}.{ttf,otf}`（支持 `preferPathTokens` / `excludePathTokens` 消歧，如 JetBrains 取 Ligatures、Zed 取 Normal）。
4. `wawoff2.compress` 串行转码 → `packages/theme/resources/fonts/generated/<id>/<id>-{regular,bold}.woff2`。
5. 默认字体：从已入库的完整 woff2 切 latin 子集分片，并生成 `packages/theme/src/fonts/default-font-face.generated.css`（四条 `@font-face`）。
6. 扫描成功产物生成 manifest。
7. 打印「已处理 / 跳过」清单。

产物（woff2、子集分片、生成的 CSS）与 manifest **均入库**；日常 `bun run build` 不重跑此步，仅在更新字体清单或 Nerd Fonts 版本时手动执行。**产物已入库时跳过下载与转码**（只重建 manifest / 子集），离线可重跑、幂等；`--force` 才强制重建。

## 默认字体的 latin 子集（两段加载）

终端首帧过去要等 2.3 MB 的完整 Geist Mono，400 ms / 2 Mbps 链路上这是十几秒。现在默认字体拆成两段：

- **子集面**：`GeistMonoNerdFontMono-{Regular,Bold}-latin.woff2`，44 / 47 KB（完整面各 1.16 MB，压到 3.8%）。覆盖拉丁 / 变音 / 希腊 / 西里尔、标点、货币、箭头、数学、制表 + 块 + 几何、常用符号、Powerline `U+E0A0–E0D4`、变体选择符（`LATIN_SUBSET_RANGES`）。
- **完整面**：`unicode-range` 由产物 cmap 反推，与子集面**严格互补**（子集 701 个码位 / 98 段，完整面 10 361 个码位 / 19 段，基本是 Nerd 图标 PUA）。字体本身没有的码位（CJK 等）不在任何一面里——这正是「浏览器不会为一个中文字去拉 1.16 MB」的关键。
- `apps/fe/src/index.css` 不再手写默认字体的 `@font-face`，改为 `@import` 生成的 `default-font-face.generated.css`。该 CSS 是生成文件，已在 `biome.json` 的 ignore 里，**不要 lint / format**。
- 产物计数：`packages/theme/resources/fonts` 下共 **17** 个 woff2（扁平 5 个 = 2 子集 + 2 完整 + 符号兜底，`generated/` 下 12 个）。回归测试 `packages/theme/src/fonts/subset-faces.test.ts` 钉住体积上限、两段 range 互不相交、首帧样本落在子集内、生成的 CSS 与 manifest 一致。

> 默认字体 Geist Mono 沿用仓库已有的扁平 woff2（`packages/theme/resources/fonts/GeistMonoNerdFontMono-*.woff2`），工具不重新下载，只从它们切出 latin 子集分片，并在 manifest 中以默认项引用既有文件。

## 运行时接线

- 字体产物归 `@vibeterm/theme` 所有；开源 FE 经相对 symlink `apps/fe/public/fonts → packages/theme/resources/fonts` 把它们挂到 `/fonts` 下，所以 URL 仍是 `/fonts/generated/<id>/…`。
- `packages/theme/src/fonts/index.ts`：`resolveFontStack(id)` 由 manifest 派生 `主字体, NotoSansSymbols2VibeTerm, monospace`；两段加载 API：
  - `loadTerminalFontStages(id, size) → { ready, startUpgrade }`：**终端启动走这条**。`ready` 只等首帧样本（默认字体 = 子集面，其它字体 = 整份），`startUpgrade()` 才发起 Nerd 图标完整面 + 符号兜底，由首个真实快照落地时触发，到达后整屏重绘。
  - `loadTerminalFonts(id, size)`：语义仍是「两段都等」，留给**不在关键路径上**的 canvas 调用方（`TerminalPreview`、分享回放）——canvas 不像 DOM 文本那样会自己触发 swap 下载，少了二段会永远是兜底字形。
  - 非默认字体运行时注入 `@font-face` 并 `FontFaceSet.load` Regular/Bold（首屏只加载默认字体的子集面，避免一次拉全部）。
- `apps/fe/src/lib/fonts/useAppMonoFont.ts`：挂应用根，把选中字体写到 `:root` 的 `--font-mono`，全应用所有 `font-mono` 文本统一跟随。
- 字号 / 行高仅作用于终端（`useUIStore.terminalFontSize / terminalLineHeight`，经 `ghostty-terminal` 的 `fontSize` / `lineHeight` init option）。

## 当前结果（Nerd Fonts v3.4.0）

**已处理（7）**：Geist Mono（默认）、JetBrains Mono、Fira Code、Blex Mono（IBM Plex Mono）、Noto Sans Mono、Zed Mono、Victor Mono。

**跳过（3，上游缺 Bold）**：3270、BigBlue Terminal、Departure Mono。

> 跳过项保留在 `fonts.config.ts` 中：将来上游补齐 Bold 时重跑即自动纳入。

## 加新字体

1. 在 `fonts.config.ts` 的 `FONTS` 追加一项（`asset` 用 Nerd Fonts release 资产名，`matchPrefix` 用压缩包内字体文件名前缀——二者可能不同，如 BlexMono 在 `IBMPlexMono.zip` 内）。
2. `bun run build:fonts`。
3. 检查输出的「跳过清单」确认是否落地；提交 `packages/theme/resources/fonts/generated/<id>/` 与 `manifest.generated.ts`。

> `manifest.generated.ts` 是生成文件，**不要手改 / lint / format**。
