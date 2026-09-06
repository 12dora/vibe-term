// 安装来源的判定：install.sh 打的标最优先，其次是包管理器变量，都没有就是直接跑 CLI。

import { describe, expect, test } from 'bun:test';
import { detectInstallSource } from './install-source';

describe('detectInstallSource', () => {
  test('install.sh 打标（含改名前的旧变量）', () => {
    expect(detectInstallSource({ VIBETERM_INSTALL_SOURCE: 'install.sh' })).toBe('install-script');
    expect(detectInstallSource({ TMEX_INSTALL_SOURCE: 'install.sh' })).toBe('install-script');
  });

  test('打标优先于包管理器变量：install.sh 里也可能是 npm 拉的包', () => {
    expect(
      detectInstallSource({
        VIBETERM_INSTALL_SOURCE: 'install.sh',
        npm_config_user_agent: 'npm/10.8.2 node/v22.11.0 darwin arm64',
      })
    ).toBe('install-script');
  });

  test('npx / 各家包管理器跑起来的都算 npx', () => {
    expect(detectInstallSource({ npm_config_user_agent: 'npm/10.8.2 node/v22.11.0' })).toBe('npx');
    expect(detectInstallSource({ npm_config_user_agent: 'pnpm/9.12.0 npm/? node/v22.11.0' })).toBe(
      'npx'
    );
    expect(detectInstallSource({ npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' })).toBe(
      'npx'
    );
  });

  test('直接执行 CLI：什么标都没有', () => {
    expect(detectInstallSource({})).toBe('cli');
    expect(detectInstallSource({ npm_config_user_agent: '' })).toBe('cli');
    expect(detectInstallSource({ VIBETERM_INSTALL_SOURCE: 'unknown' })).toBe('cli');
  });
});
