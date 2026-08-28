// 生成 themes.css / hljs-terminal-theme.css 中的 [data-theme-preset="…"] 区块
// （真源 = packages/theme/src/preset-palettes.ts）。
// 用法：bun scripts/theme/build-theme-presets.ts

import fs from 'node:fs';
import path from 'node:path';
import { renderPresetCssSections, replacePresetSection } from '../../packages/theme/src/preset-css';

const repoRoot = path.join(import.meta.dir, '../..');
const targets: Record<'themes' | 'hljs', string> = {
  themes: path.join(repoRoot, 'packages/theme/src/themes.css'),
  hljs: path.join(repoRoot, 'packages/panels/src/code-viewer/hljs-terminal-theme.css'),
};

const sections = renderPresetCssSections();

for (const key of Object.keys(targets) as ('themes' | 'hljs')[]) {
  const file = targets[key];
  const current = fs.readFileSync(file, 'utf8');
  const next = replacePresetSection(current, sections[key]);
  if (next === current) {
    console.log(`[theme] up to date ${file}`);
    continue;
  }
  fs.writeFileSync(file, next);
  console.log(`[theme] wrote ${file}`);
}
