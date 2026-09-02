import { afterEach, describe, expect, test } from 'bun:test';
import { cliHelpText } from '../cli/help';
import { normalizeLang, setLang, t } from './index';

describe('i18n', () => {
  afterEach(() => {
    setLang('en');
  });

  test('normalizes language values', () => {
    expect(normalizeLang(undefined)).toBe('en');
    expect(normalizeLang('en')).toBe('en');
    expect(normalizeLang('en-US')).toBe('en');
    expect(normalizeLang('zh')).toBe('zh-CN');
    expect(normalizeLang('zh-CN')).toBe('zh-CN');
    expect(normalizeLang('unknown')).toBe('en');
  });

  test('renders english by default', () => {
    expect(t('cli.error.unknownCommand', { command: 'foo' })).toContain('Unknown command');
  });

  test('switches language and interpolates vars', () => {
    setLang('zh-CN');
    expect(t('cli.error.unknownCommand', { command: 'foo' })).toBe('未知命令：foo');
  });

  test('cli.help is sourced from cliHelpText', () => {
    setLang('en');
    expect(t('cli.help')).toBe(cliHelpText('en'));
    expect(t('cli.help')).toContain('tmex hub user add <username>');
    expect(t('cli.help')).toContain('tmex hub user passwd <username> [--full-reset]');
    expect(t('cli.help')).toContain('tmex direct enable|disable');
    setLang('zh-CN');
    expect(t('cli.help')).toBe(cliHelpText('zh-CN'));
    expect(t('cli.help')).toContain('tmex hub join');
    expect(t('cli.help')).toContain('--no-restart');
    expect(t('cli.help')).toContain('同时移除所有通行密钥、两步验证并注销全部会话');
  });

  test('path hint exists in both languages and zh-CN avoids 你', () => {
    setLang('en');
    expect(t('cli.shim.pathHint', { binDir: '/tmp/bin' })).toContain('/tmp/bin');
    setLang('zh-CN');
    const zh = t('cli.shim.pathHint', { binDir: '/tmp/bin' });
    expect(zh).toContain('/tmp/bin');
    expect(zh).toContain('PATH');
    expect(zh).not.toContain('你');
  });

  test('passwd hub errors exist in both languages and zh-CN avoids 你/您', () => {
    const keys = [
      'hub.user.passwd.hubTimeout',
      'hub.user.passwd.hubNotWriter',
      'hub.user.passwd.nodesTooOld',
      'hub.user.passwd.doneKeep',
      'hub.user.passwd.doneFullReset',
    ] as const;
    setLang('en');
    expect(t('hub.user.passwd.hubTimeout')).toMatch(/unreachable|not submitted/i);
    expect(t('hub.user.passwd.nodesTooOld')).toContain('1.1.16');
    expect(t('hub.user.passwd.doneKeep', { username: 'bob' })).toContain('bob');
    expect(t('hub.user.passwd.doneKeep', { username: 'bob' })).toMatch(/keep/i);
    expect(t('hub.user.passwd.doneFullReset', { username: 'bob' })).toMatch(/full-reset/i);
    setLang('zh-CN');
    expect(t('hub.user.passwd.hubTimeout')).toBe(
      '主 Hub 不可达，修改未提交；请先切换 Hub 角色后重试。'
    );
    expect(t('hub.user.passwd.nodesTooOld')).toBe('有节点版本低于 1.1.16，须先升级全部节点。');
    for (const key of keys) {
      const zh = t(key, { username: 'bob' });
      expect(zh).not.toBe(key);
      expect(zh).not.toContain('你');
      expect(zh).not.toContain('您');
    }
  });

  test('skipForeign exists in both languages and zh-CN avoids 你', () => {
    setLang('en');
    expect(t('cli.shim.skipForeign', { path: '/tmp/tmex' })).toContain('/tmp/tmex');
    setLang('zh-CN');
    const zh = t('cli.shim.skipForeign', { path: '/tmp/tmex' });
    expect(zh).toContain('/tmp/tmex');
    expect(zh).not.toContain('你');
  });
});
