// 网关只加载服务端前缀表内的文案；这里扫描网关源码里出现的全部 i18n key（字面量与模板前缀），
// 任何一个落在前缀表外都会在运行时渲染成 key 本身，因此直接失败。
// 修复方式：把前缀补进 packages/shared/src/i18n/server-keys.ts 并重新跑 `bun run build:i18n`。

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { I18N_SERVER_KEY_PREFIXES, isServerI18nKey } from '@vibeterm/shared/i18n/server-keys';

type TranslationTree = { [key: string]: string | TranslationTree };

const SRC_DIR = join(import.meta.dir, '..');
const EN_US = join(import.meta.dir, '../../../../packages/shared/src/i18n/locales/en_US.json');
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const LITERAL = /['"`]([A-Za-z][\w-]*(?:\.[\w-]+)+)['"`]/g;
const TEMPLATE_PREFIX = /[`]([A-Za-z][\w-]*(?:\.[\w-]+)*)\.\$\{/g;

function leafKeys(tree: TranslationTree, prefix = '', out: string[] = []): string[] {
  for (const [key, value] of Object.entries(tree)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.push(full);
    else leafKeys(value, full, out);
  }
  return out;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.ts$/.test(entry) && !/\.(test|integration|bench)\.ts$/.test(entry)) out.push(path);
  }
  return out;
}

const leaves = leafKeys(JSON.parse(readFileSync(EN_US, 'utf8')).translation);
const leafSet = new Set([...leaves, ...leaves.map((key) => key.replace(PLURAL_SUFFIX, ''))]);
const leavesUnder = (node: string) => leaves.filter((key) => key.startsWith(`${node}.`));

function usedKeys(): Map<string, string> {
  const used = new Map<string, string>();
  for (const file of sourceFiles(SRC_DIR)) {
    const src = readFileSync(file, 'utf8');
    const where = relative(SRC_DIR, file);
    for (const [, key] of src.matchAll(LITERAL)) {
      if (leafSet.has(key)) used.set(key, where);
      else for (const leaf of leavesUnder(key)) used.set(leaf, where);
    }
    for (const [, node] of src.matchAll(TEMPLATE_PREFIX)) {
      for (const leaf of leavesUnder(node)) used.set(leaf, where);
    }
  }
  return used;
}

describe('gateway i18n server key allowlist', () => {
  const used = usedKeys();

  test('扫描到的 key 数量正常（守卫不是空转）', () => {
    expect(used.size).toBeGreaterThan(150);
  });

  test('网关源码用到的 key 全部在服务端前缀表内', () => {
    const outside = [...used]
      .filter(([key]) => !isServerI18nKey(key))
      .map(([key, where]) => `${key} (${where})`);
    expect(outside).toEqual([]);
  });

  test('前缀表没有死条目', () => {
    const dead = I18N_SERVER_KEY_PREFIXES.filter(
      (prefix) => !leaves.some((key) => isServerI18nKey(key) && key.startsWith(prefix))
    );
    expect(dead).toEqual([]);
  });
});
