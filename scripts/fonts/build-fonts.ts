#!/usr/bin/env bun
/**
 * 字体构建工具（issue #14）
 *
 * 流程：
 *  1. 读 fonts.config.ts（精选清单 + Nerd Fonts 资产）
 *  2. 逐字体从 Nerd Fonts pinned release 下载资产 zip（缓存到 scripts/fonts/.cache）
 *  3. 解压，定位 Mono 的 Regular + Bold 两字重（缺 Bold 即跳过并记录）
 *  4. 用 wawoff2 无损转码成 woff2（不子集、保留全部字形含 Nerd 图标）
 *     → packages/theme/resources/fonts/generated/<id>/<id>-{regular,bold}.woff2
 *  5. 默认字体额外生成 latin 子集分片（见 ./latin-subset）
 *  6. 扫描成功产物，生成 packages/theme/src/fonts/manifest.generated.ts
 *  7. 打印跳过清单
 *
 * 默认字体 Geist Mono 沿用仓库已有扁平 woff2（已静态 @font-face），不下载、不进 generated。
 * 开源 FE 经 apps/fe/public/fonts → packages/theme/resources/fonts 相对 symlink 提供 /fonts。
 *
 * 用法：bun run build:fonts [--force]
 * 默认幂等：产物已在库里就跳过下载与转码，只重算 manifest（因此离线也能重跑子集这一步）；
 * `--force` 才重新下载并转码。woff2 与 manifest 均入库；日常 build 无需重跑。
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as wawoff2 from 'wawoff2';
import {
  FONTS,
  type FontSource,
  LATIN_SUBSET_RANGES,
  NERD_FONTS_RELEASE_BASE,
  NERD_FONTS_VERSION,
} from './fonts.config';
import { buildLatinSubset } from './latin-subset';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CACHE_DIR = path.join(__dirname, '.cache');
const EXTRACT_DIR = path.join(CACHE_DIR, 'extract');
const FONTS_ROOT = path.join(ROOT, 'packages/theme/resources/fonts');
const PUBLIC_GENERATED_DIR = path.join(FONTS_ROOT, 'generated');
const MANIFEST_OUT = path.join(ROOT, 'packages/theme/src/fonts/manifest.generated.ts');
const DEFAULT_FACE_CSS_OUT = path.join(
  ROOT,
  'packages/theme/src/fonts/default-font-face.generated.css'
);

const FORCE = process.argv.slice(2).includes('--force');

interface ManifestEntry {
  id: string;
  displayName: string;
  cssFamily: string;
  bundled: boolean;
  isDefault?: boolean;
  files?: { regular: string; bold: string };
  subset?: {
    regular: string;
    bold: string;
    unicodeRange: string;
    fullUnicodeRange: string;
  };
}

interface SkipRecord {
  id: string;
  displayName: string;
  reason: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, '');

async function downloadAsset(asset: string): Promise<string> {
  const dest = path.join(CACHE_DIR, asset);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`[fonts]   缓存命中 ${asset}`);
    return dest;
  }
  const url = `${NERD_FONTS_RELEASE_BASE}/${asset}`;
  console.log(`[fonts]   下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`下载失败 ${url} -> HTTP ${res.status}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`[fonts]   已存 ${asset}（${(buf.length / 1048576).toFixed(1)} MB）`);
  return dest;
}

function extractAsset(zipPath: string, id: string): string {
  const dest = path.join(EXTRACT_DIR, id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', dest]);
  return dest;
}

/** 在解压目录里找 `<matchPrefix>NerdFontMono-<weight>.{ttf,otf}` 的最佳匹配 */
function findWeightFile(
  extractDir: string,
  font: FontSource,
  weight: 'Regular' | 'Bold'
): string | null {
  const all = fs.readdirSync(extractDir, { recursive: true }) as string[];
  const re = new RegExp(`NerdFontMono-${weight}\\.(ttf|otf)$`, 'i');
  const prefix = norm(font.matchPrefix ?? font.id);

  let cands = all.filter((rel) => {
    const base = path.basename(rel);
    if (!re.test(base)) return false;
    if (!norm(base).startsWith(prefix)) return false;
    const lower = rel.toLowerCase();
    if (font.excludePathTokens?.some((t) => lower.includes(t.toLowerCase()))) return false;
    return true;
  });

  const prefer = font.preferPathTokens;
  if (prefer?.length) {
    const preferred = cands.filter((rel) =>
      prefer.every((t) => rel.toLowerCase().includes(t.toLowerCase()))
    );
    if (preferred.length) cands = preferred;
  }

  cands.sort((a, b) => a.length - b.length);
  return cands.length ? path.join(extractDir, cands[0]) : null;
}

async function transcode(srcTtf: string, outWoff2: string): Promise<void> {
  const input = new Uint8Array(fs.readFileSync(srcTtf));
  const out = await wawoff2.compress(input);
  fs.mkdirSync(path.dirname(outWoff2), { recursive: true });
  fs.writeFileSync(outWoff2, Buffer.from(out));
}

function generatedUrls(id: string): { regular: string; bold: string } {
  return {
    regular: `/fonts/generated/${id}/${id}-regular.woff2`,
    bold: `/fonts/generated/${id}/${id}-bold.woff2`,
  };
}

/**
 * 产物已入库时跳过下载 + 转码：重跑只为改 manifest（如新增子集字段）时不该再拉 7 个 zip，
 * 离线环境也能重建 manifest。`--force` 关掉这层复用。
 */
function reuseExistingProduct(font: FontSource): ManifestEntry | null {
  const files = generatedUrls(font.id);
  const outDir = path.join(PUBLIC_GENERATED_DIR, font.id);
  const onDisk = [`${font.id}-regular.woff2`, `${font.id}-bold.woff2`].every((name) =>
    fs.existsSync(path.join(outDir, name))
  );
  if (FORCE || !onDisk) return null;
  console.log('[fonts]   复用已入库产物（--force 可强制重建）');
  return {
    id: font.id,
    displayName: font.displayName,
    cssFamily: font.cssFamily,
    bundled: true,
    isDefault: font.isDefault,
    files,
  };
}

/** 默认字体：整份 woff2 已在库里，只需（按需）再产出 latin 子集分片 */
async function processExistingFont(
  font: FontSource,
  useExisting: { regular: string; bold: string }
): Promise<ManifestEntry> {
  const entry: ManifestEntry = {
    id: font.id,
    displayName: font.displayName,
    cssFamily: font.cssFamily,
    bundled: true,
    isDefault: font.isDefault,
    files: { regular: useExisting.regular, bold: useExisting.bold },
  };
  if (!font.latinSubset) {
    console.log('[fonts]   使用仓库已有 woff2（默认字体，静态加载）');
    return entry;
  }

  console.log('[fonts]   从已有 woff2 生成 latin 子集分片');
  const subset = await buildLatinSubset({
    fontsRoot: FONTS_ROOT,
    full: useExisting,
    subset: font.latinSubset,
    ranges: LATIN_SUBSET_RANGES,
  });
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  console.log(
    `[fonts]   ✓ 子集 regular ${kb(subset.regular.bytes)} / bold ${kb(subset.bold.bytes)}`
  );
  entry.subset = {
    regular: subset.regular.url,
    bold: subset.bold.url,
    unicodeRange: subset.unicodeRange,
    fullUnicodeRange: subset.fullUnicodeRange,
  };
  return entry;
}

async function processFont(font: FontSource): Promise<ManifestEntry | SkipRecord> {
  console.log(`[fonts] 处理 ${font.displayName} (${font.id})`);

  if (font.useExisting) {
    return processExistingFont(font, font.useExisting);
  }

  if (!font.asset) {
    return { id: font.id, displayName: font.displayName, reason: '缺少 asset 配置' };
  }

  const reused = reuseExistingProduct(font);
  if (reused) return reused;

  const zip = await downloadAsset(font.asset);
  const extractDir = extractAsset(zip, font.id);

  const regularSrc = findWeightFile(extractDir, font, 'Regular');
  const boldSrc = findWeightFile(extractDir, font, 'Bold');

  if (!regularSrc) {
    return {
      id: font.id,
      displayName: font.displayName,
      reason: `未在 ${font.asset} 找到 Regular（matchPrefix=${font.matchPrefix}，命名可能不符）`,
    };
  }
  if (!boldSrc) {
    return {
      id: font.id,
      displayName: font.displayName,
      reason: '上游缺 Bold 字重',
    };
  }

  const outDir = path.join(PUBLIC_GENERATED_DIR, font.id);
  const regularOut = path.join(outDir, `${font.id}-regular.woff2`);
  const boldOut = path.join(outDir, `${font.id}-bold.woff2`);

  // wawoff2 是共享 emscripten 单例，串行转码
  console.log(`[fonts]   转码 Regular: ${path.basename(regularSrc)}`);
  await transcode(regularSrc, regularOut);
  console.log(`[fonts]   转码 Bold:    ${path.basename(boldSrc)}`);
  await transcode(boldSrc, boldOut);

  const rSize = (fs.statSync(regularOut).size / 1048576).toFixed(2);
  const bSize = (fs.statSync(boldOut).size / 1048576).toFixed(2);
  console.log(`[fonts]   ✓ ${font.id}: regular ${rSize}MB / bold ${bSize}MB`);

  return {
    id: font.id,
    displayName: font.displayName,
    cssFamily: font.cssFamily,
    bundled: true,
    isDefault: font.isDefault,
    files: generatedUrls(font.id),
  };
}

function faceRule(family: string, url: string, weight: 400 | 700, unicodeRange?: string): string {
  const lines = [
    '@font-face {',
    `  font-family: ${family};`,
    `  src: url("${url}") format("woff2");`,
    `  font-weight: ${weight};`,
    '  font-style: normal;',
    '  font-display: swap;',
  ];
  if (unicodeRange) lines.push(`  unicode-range: ${unicodeRange};`);
  lines.push('}');
  return lines.join('\n');
}

/**
 * 默认字体的 @font-face 由构建生成：子集面与完整面的 unicode-range 必须与产物 cmap
 * 严格一致，手写 CSS 一定会跟生成物漂移。apps/fe/src/index.css 只 @import 这个文件。
 */
function writeDefaultFontFaceCss(entry: ManifestEntry): void {
  const files = entry.files;
  if (!files) return;
  const header = `/* Auto-generated by scripts/fonts/build-fonts.ts —— 不要手改 / lint / format。
   默认终端字体 ${entry.displayName} 拆两段：
   · 子集面（约 45 KB / 字重）覆盖拉丁、制表、块元素与 Powerline，终端首帧只等它；
   · 完整面（1.16 MB / 字重）覆盖余下的 Nerd 图标 PUA，font-display:swap 后到再重绘。
   两个 unicode-range 由产物 cmap 反推、严格互补：字体没有的码位（如 CJK）不在任何一面里，
   浏览器不会为它们去下载完整文件，直接落到字体栈后段的系统 monospace。 */\n`;

  const rules = entry.subset
    ? [
        faceRule(entry.cssFamily, entry.subset.regular, 400, entry.subset.unicodeRange),
        faceRule(entry.cssFamily, entry.subset.bold, 700, entry.subset.unicodeRange),
        faceRule(entry.cssFamily, files.regular, 400, entry.subset.fullUnicodeRange),
        faceRule(entry.cssFamily, files.bold, 700, entry.subset.fullUnicodeRange),
      ]
    : [faceRule(entry.cssFamily, files.regular, 400), faceRule(entry.cssFamily, files.bold, 700)];

  fs.writeFileSync(DEFAULT_FACE_CSS_OUT, `${header}${rules.join('\n')}\n`, 'utf-8');
  console.log(`[fonts] 生成 @font-face: ${path.relative(ROOT, DEFAULT_FACE_CSS_OUT)}`);
}

function writeManifest(entries: ManifestEntry[]): void {
  const defaultId = entries.find((e) => e.isDefault)?.id ?? entries[0]?.id ?? 'geist-mono';
  const body = entries
    .map((e) => {
      const lines = [
        `    id: ${JSON.stringify(e.id)},`,
        `    displayName: ${JSON.stringify(e.displayName)},`,
        `    cssFamily: ${JSON.stringify(e.cssFamily)},`,
        `    bundled: ${e.bundled},`,
      ];
      if (e.isDefault) lines.push('    isDefault: true,');
      if (e.files) {
        lines.push(
          `    files: { regular: ${JSON.stringify(e.files.regular)}, bold: ${JSON.stringify(e.files.bold)} },`
        );
      }
      if (e.subset) {
        lines.push(
          '    subset: {',
          `      regular: ${JSON.stringify(e.subset.regular)},`,
          `      bold: ${JSON.stringify(e.subset.bold)},`,
          `      unicodeRange: ${JSON.stringify(e.subset.unicodeRange)},`,
          `      fullUnicodeRange: ${JSON.stringify(e.subset.fullUnicodeRange)},`,
          '    },'
        );
      }
      return `  {\n${lines.join('\n')}\n  },`;
    })
    .join('\n');

  const content = `// Auto-generated by scripts/fonts/build-fonts.ts
// Do not edit this file directly. Run \`bun run build:fonts\` to regenerate.
// Nerd Fonts ${NERD_FONTS_VERSION}
import type { FontManifestEntry } from './types';

export const FONT_MANIFEST: FontManifestEntry[] = [
${body}
];

export const DEFAULT_FONT_ID = ${JSON.stringify(defaultId)};
`;

  fs.mkdirSync(path.dirname(MANIFEST_OUT), { recursive: true });
  fs.writeFileSync(MANIFEST_OUT, content, 'utf-8');
  console.log(
    `[fonts] 生成 manifest: ${path.relative(ROOT, MANIFEST_OUT)}（${entries.length} 个字体）`
  );
}

async function main() {
  console.log(`[fonts] Nerd Fonts ${NERD_FONTS_VERSION} —— 开始构建`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });

  const entries: ManifestEntry[] = [];
  const skipped: SkipRecord[] = [];

  for (const font of FONTS) {
    const result = await processFont(font);
    if ('reason' in result) {
      skipped.push(result);
      console.log(`[fonts]   ✗ 跳过 ${font.id}：${result.reason}`);
    } else {
      entries.push(result);
    }
  }

  writeManifest(entries);
  const defaultEntry = entries.find((e) => e.isDefault);
  if (defaultEntry) writeDefaultFontFaceCss(defaultEntry);

  console.log('\n========== 构建结果 ==========');
  console.log(`已处理（${entries.length}）：${entries.map((e) => e.id).join(', ')}`);
  if (skipped.length) {
    console.log(`\n跳过清单（${skipped.length}）：`);
    for (const s of skipped) {
      console.log(`  - ${s.displayName} (${s.id})：${s.reason}`);
    }
  }
  console.log('==============================');
}

main().catch((err) => {
  console.error('[fonts] 构建失败：', err);
  process.exit(1);
});
