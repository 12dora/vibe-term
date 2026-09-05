// `share.*` 里既有直接写死的 key，也有 `share.dialog.duration.${choice}` 这类拼出来的，
// 静态扫描抓不全，故这里维护一份完整清单：三语都得有，且语言包里不许有清单外的孤儿 key。

import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCALES = ['en_US', 'zh_CN', 'ja_JP'] as const;

const SHARE_KEYS: readonly string[] = [
  'share.toolbar.share',
  'share.toolbar.active',
  'share.dialog.title',
  'share.dialog.desc',
  'share.dialog.name',
  'share.dialog.namePlaceholder',
  'share.dialog.duration.label',
  'share.dialog.duration.hour',
  'share.dialog.duration.day',
  'share.dialog.duration.week',
  'share.dialog.duration.permanent',
  'share.dialog.duration.custom',
  'share.dialog.duration.unit.hours',
  'share.dialog.duration.unit.days',
  'share.dialog.password',
  'share.dialog.regenerate',
  'share.dialog.address',
  'share.dialog.noAddress',
  'share.dialog.create',
  'share.dialog.link',
  'share.dialog.copy',
  'share.dialog.copied',
  'share.dialog.copyFailed',
  'share.dialog.passwordOnce',
  'share.dialog.viewers',
  'share.dialog.expires',
  'share.dialog.permanent',
  'share.dialog.remaining.days',
  'share.dialog.remaining.hours',
  'share.dialog.remaining.minutes',
  'share.dialog.remaining.expired',
  'share.dialog.stop',
  'share.dialog.stopConfirmTitle',
  'share.dialog.stopConfirm',
  'share.dialog.created',
  'share.dialog.stopped',
  'share.dialog.loadFailed',
  'share.error.nameRequired',
  'share.error.passwordTooShort',
  'share.error.noOrigin',
  'share.error.invalidDuration',
  // 服务端契约错误码（`shareErrorKey` 直接拼 `share.error.<code>`）与通用兜底
  'share.error.generic',
  'share.error.SHARE_NOT_FOUND',
  'share.error.SHARE_WINDOW_NOT_FOUND',
  'share.error.SHARE_PASSWORD_TOO_SHORT',
  'share.error.SHARE_ORIGIN_INVALID',
  'share.error.SHARE_ENDED',
  'share.error.SHARE_AUTH_REQUIRED',
];

const localesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../shared/src/i18n/locales'
);

type Tree = { [key: string]: string | Tree };

async function shareTree(locale: string): Promise<Tree> {
  const json = (await Bun.file(path.join(localesDir, `${locale}.json`)).json()) as {
    translation: { share: Tree };
  };
  return json.translation.share;
}

function flatten(tree: Tree, prefix: string, out: string[]): void {
  for (const [key, value] of Object.entries(tree)) {
    const full = `${prefix}.${key}`;
    if (typeof value === 'string') out.push(full);
    else flatten(value, full, out);
  }
}

function lookup(tree: Tree, key: string): unknown {
  return key
    .split('.')
    .slice(1)
    .reduce<unknown>((node, part) => {
      if (typeof node !== 'object' || node === null) return undefined;
      return (node as Record<string, unknown>)[part];
    }, tree);
}

describe('share i18n', () => {
  for (const locale of LOCALES) {
    test(`${locale} 覆盖全部 share key 且没有孤儿`, async () => {
      const tree = await shareTree(locale);
      for (const key of SHARE_KEYS) {
        expect(typeof lookup(tree, key)).toBe('string');
      }
      const actual: string[] = [];
      flatten(tree, 'share', actual);
      expect(actual.sort()).toEqual([...SHARE_KEYS].sort());
    });
  }

  test('带参文案在三语里都保留了插值占位符', async () => {
    const placeholders: Record<string, string> = {
      'share.toolbar.active': '{{count}}',
      'share.dialog.viewers': '{{count}}',
      'share.dialog.remaining.days': '{{value}}',
      'share.dialog.remaining.hours': '{{value}}',
      'share.dialog.remaining.minutes': '{{value}}',
      'share.error.passwordTooShort': '{{min}}',
    };
    for (const locale of LOCALES) {
      const tree = await shareTree(locale);
      for (const [key, token] of Object.entries(placeholders)) {
        expect(String(lookup(tree, key))).toContain(token);
      }
    }
  });
});
