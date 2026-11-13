import { describe, expect, test } from 'bun:test';
import { isSkippedPath, scanSensitive } from './sensitive-content';

describe('sensitive-content gate', () => {
  test('flags audit material paths', () => {
    const dirs = ['aud' + 'it', 'p' + 'oc', 'pen' + 'test'];
    for (const path of [
      `docs/security/${dirs[0]}-2026.md`,
      `${dirs[1]}/relay.ts`,
      `reports/${dirs[2]}.md`,
    ]) {
      expect(scanSensitive(path, '').map((hit) => hit.rule)).toContain('path');
    }
    expect(scanSensitive('docs/security/access-tokens.md', '')).toEqual([]);
  });

  test('flags finding ids and audit wording, not ordinary text', () => {
    const findingId = ['A', '01'].join('-');
    expect(scanSensitive('a.ts', `test('${findingId}: spoofed header', () => {})`)[0]?.rule).toBe(
      'finding-id'
    );
    expect(scanSensitive('a.md', `复现步骤见 ${'Po'}C`)[0]?.rule).toBe('audit-wording');
    expect(scanSensitive('a.md', `限额（${'C'}8）`)[0]?.rule).toBe('finding-id');
    expect(scanSensitive('a.ts', `test('${'C'}2：auto admit')`)[0]?.rule).toBe('finding-id');
    expect(scanSensitive('a.md', '参见 KI-16；版本 2.15.0；E2E 测试；C1 控制字符；F12 键')).toEqual(
      []
    );
  });

  test('skips vendored licences and generated i18n', () => {
    expect(isSkippedPath('packages/app/src/vendor/node-datachannel/LICENSE')).toBe(true);
    expect(isSkippedPath('packages/shared/src/i18n/resources.ts')).toBe(true);
    expect(isSkippedPath('docs/README.md')).toBe(false);
  });
});
