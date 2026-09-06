// 安装来源的判定：install-meta 里记了什么就是什么，老 meta 没记按 CLI，压根没有 meta 是手动/容器。

import { describe, expect, test } from 'bun:test';
import { installSourceFromMeta } from './install-info';

describe('installSourceFromMeta', () => {
  test('没有 install-meta：手动部署或容器', () => {
    expect(installSourceFromMeta(null)).toBe('manual');
  });

  test('记了来源就照原样返回', () => {
    expect(installSourceFromMeta({ installSource: 'install-script' })).toBe('install-script');
    expect(installSourceFromMeta({ installSource: 'npx' })).toBe('npx');
    expect(installSourceFromMeta({ installSource: 'cli' })).toBe('cli');
  });

  test('老安装没记来源，或记了不认识的值：都按 CLI', () => {
    expect(installSourceFromMeta({ cliVersion: '1.1.40' })).toBe('cli');
    expect(installSourceFromMeta({ installSource: 'homebrew' })).toBe('cli');
  });
});
