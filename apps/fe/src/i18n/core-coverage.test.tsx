// core 语言包的覆盖守卫：入口 chunk 里出现的每一个 i18n key 都必须落在 core 包里，
// 否则首屏（rest 包还没到）会渲染出裸 key。
// 做法是从 main.tsx 出发重建**静态** import 图（遇到 import() 即止步），
// 这张图比 rollup 摇树后的入口 chunk 更大，因此是保守口径：图里没有的 key 一定不在首屏。

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PageLoadFallback } from '@/PageLoadFallback';
import { createInstance } from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import {
  I18N_CORE_KEY_PREFIXES,
  isCoreI18nKey,
} from '../../../../packages/shared/src/i18n/core-keys';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const FE_SRC = join(REPO_ROOT, 'apps/fe/src');
const SHARED_I18N = join(REPO_ROOT, 'packages/shared/src/i18n');

const PKG_DIRS: Record<string, string> = {
  '@tmex/panels': 'packages/panels',
  '@tmex/ui': 'packages/ui',
  '@tmex/stores': 'packages/stores',
  '@tmex/terminal-ui': 'packages/terminal-ui',
  '@tmex/api-client': 'packages/api-client',
  '@tmex/ws-client': 'packages/ws-client',
  '@tmex/shared': 'packages/shared',
  '@tmex/theme': 'packages/theme',
  '@tmex/notifications': 'packages/notifications',
  'ghostty-terminal': 'packages/ghostty-terminal',
};

const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];

function resolveFile(base: string): string | null {
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function resolveWorkspaceSpecifier(spec: string): string | null {
  const pkg = Object.keys(PKG_DIRS).find((name) => spec === name || spec.startsWith(`${name}/`));
  if (!pkg) return null;
  const sub = spec === pkg ? '.' : `./${spec.slice(pkg.length + 1)}`;
  const map = JSON.parse(readFileSync(join(REPO_ROOT, PKG_DIRS[pkg], 'package.json'), 'utf8'))
    .exports as Record<string, string> | undefined;
  if (!map) return null;

  let target = map[sub];
  if (!target) {
    for (const [pattern, value] of Object.entries(map)) {
      if (!pattern.includes('*')) continue;
      const [head, tail] = pattern.split('*');
      if (!sub.startsWith(head) || !sub.endsWith(tail)) continue;
      target = value.replace('*', sub.slice(head.length, sub.length - tail.length));
      break;
    }
  }
  if (!target) return null;
  return resolveFile(join(REPO_ROOT, PKG_DIRS[pkg], target.replace(/^\.\//, '')));
}

function resolveSpecifier(spec: string, fromFile: string): string | null {
  if (spec.startsWith('.')) return resolveFile(resolve(dirname(fromFile), spec));
  if (spec.startsWith('@/')) return resolveFile(join(FE_SRC, spec.slice(2)));
  return resolveWorkspaceSpecifier(spec);
}

/** 从 main.tsx 出发的静态 import 闭包（import() 是边界，不跨过去）。 */
function eagerModules(): string[] {
  const seen = new Set<string>();
  const pending = [join(FE_SRC, 'main.tsx')];

  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(ts|tsx)$/.test(file)) continue;

    const source = readFileSync(file, 'utf8');
    for (const spec of new Bun.Transpiler({ loader: 'tsx' }).scanImports(source)) {
      if (spec.kind === 'dynamic-import') continue;
      const resolved = resolveSpecifier(spec.path, file);
      if (resolved && !seen.has(resolved)) pending.push(resolved);
    }
  }
  return [...seen];
}

type TranslationTree = { [key: string]: string | TranslationTree };

function leafKeys(tree: TranslationTree, prefix = '', out: string[] = []): string[] {
  for (const [key, value] of Object.entries(tree)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.push(full);
    else leafKeys(value, full, out);
  }
  return out;
}

function readTranslation(file: string): TranslationTree {
  return JSON.parse(readFileSync(file, 'utf8')).translation as TranslationTree;
}

const fullTranslation = readTranslation(join(SHARED_I18N, 'locales/en_US.json'));
const coreTranslation = readTranslation(join(SHARED_I18N, 'locales/generated/en_US.core.json'));
const restTranslation = readTranslation(join(SHARED_I18N, 'locales/generated/en_US.rest.json'));

const allLeaves = new Set(leafKeys(fullTranslation));
const allNodes = new Set<string>();
for (const key of allLeaves) {
  const parts = key.split('.');
  for (let i = 1; i <= parts.length; i++) allNodes.add(parts.slice(0, i).join('.'));
}

const LITERAL_KEY = /['"`]([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)['"`]/g;
const TEMPLATE_PREFIX = /`([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)*)\.?\$\{/g;

interface Usage {
  key: string;
  file: string;
}

/** 入口图里出现的 key：字面量按原样收，模板前缀展开成该子树下的全部叶子。 */
function eagerKeyUsages(): Usage[] {
  const usages: Usage[] = [];
  for (const file of eagerModules()) {
    if (file.startsWith(SHARED_I18N)) continue;
    const source = readFileSync(file, 'utf8');
    const rel = file.slice(REPO_ROOT.length + 1);

    LITERAL_KEY.lastIndex = 0;
    let match = LITERAL_KEY.exec(source);
    while (match) {
      const key = match[1];
      const base = key.replace(/_(zero|one|two|few|many|other)$/, '');
      if (allLeaves.has(key)) usages.push({ key, file: rel });
      else if (allLeaves.has(base)) usages.push({ key: base, file: rel });
      match = LITERAL_KEY.exec(source);
    }

    TEMPLATE_PREFIX.lastIndex = 0;
    match = TEMPLATE_PREFIX.exec(source);
    while (match) {
      const prefix = match[1];
      if (allNodes.has(prefix) && !allLeaves.has(prefix)) {
        for (const key of allLeaves) {
          if (key.startsWith(`${prefix}.`)) usages.push({ key, file: rel });
        }
      }
      match = TEMPLATE_PREFIX.exec(source);
    }
  }
  return usages;
}

const usages = eagerKeyUsages();

describe('i18n core/rest 拆分', () => {
  test('入口静态图规模合理（守卫解析逻辑没有整体失效）', () => {
    expect(eagerModules().length).toBeGreaterThan(100);
    expect(usages.length).toBeGreaterThan(100);
  });

  test('core + rest 恰好等于完整语言包，且互不重叠', () => {
    const core = leafKeys(coreTranslation);
    const rest = leafKeys(restTranslation);
    expect([...core, ...rest].sort()).toEqual([...allLeaves].sort());
    expect(core.filter((key) => rest.includes(key))).toEqual([]);
    expect(core.every(isCoreI18nKey)).toBe(true);
    expect(rest.some(isCoreI18nKey)).toBe(false);
  });

  test('每个 core 前缀都还有对应的 key（前缀表不留死条目）', () => {
    for (const prefix of I18N_CORE_KEY_PREFIXES) {
      const hit = [...allLeaves].some((key) => key === prefix || key.startsWith(`${prefix}.`));
      expect(`${prefix}:${hit}`).toBe(`${prefix}:true`);
    }
  });

  test('入口 chunk 用到的 key 全部落在 core 包里', () => {
    const coreLeaves = new Set(leafKeys(coreTranslation));
    const missing = usages
      .filter((usage) => !coreLeaves.has(usage.key))
      .map((usage) => `${usage.key} <- ${usage.file}`);
    expect([...new Set(missing)].sort()).toEqual([]);
  });

  test('只装载 core 包时，入口图里的 key 全部可解析且不触发 missingKey', async () => {
    const missing: string[] = [];
    const i18n = createInstance();
    await i18n.init({
      lng: 'en_US',
      fallbackLng: 'en_US',
      ns: ['translation'],
      defaultNS: 'translation',
      resources: { en_US: { translation: coreTranslation as never } },
      interpolation: { escapeValue: false },
      returnNull: false,
      saveMissing: true,
      missingKeyHandler: (_lngs, _ns, key) => void missing.push(key),
    });

    for (const usage of usages) i18n.t(usage.key);

    // 外壳里最早可能渲染的一块（懒路由 chunk 加载失败时的重试卡片）——只有 core 也必须是人话。
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <PageLoadFallback onRetry={() => undefined} />
      </I18nextProvider>
    );
    expect(markup).not.toMatch(/common\.[a-zA-Z]/);
    expect(markup).toContain(i18n.t('common.pageLoadFailed'));

    expect([...new Set(missing)].sort()).toEqual([]);
  });
});
