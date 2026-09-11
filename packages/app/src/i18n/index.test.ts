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
    expect(t('cli.help')).toContain('vibeterm hub user add <username>');
    expect(t('cli.help')).toContain('vibeterm hub user passwd <username> [--full-reset]');
    expect(t('cli.help')).toContain('vibeterm direct enable|disable');
    setLang('zh-CN');
    expect(t('cli.help')).toBe(cliHelpText('zh-CN'));
    expect(t('cli.help')).toContain('vibeterm hub join');
    expect(t('cli.help')).toContain('vibeterm relay join');
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

  test('hub.join.admitPending exists in both languages and zh-CN avoids 你', () => {
    setLang('en');
    expect(t('hub.join.admitPending')).toMatch(/waiting for approval/i);
    setLang('zh-CN');
    const zh = t('hub.join.admitPending');
    expect(zh).toContain('已加入');
    expect(zh).toContain('批准');
    expect(zh).not.toContain('你');
    expect(zh).not.toContain('您');
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

  // 两个结局都要说清：密码会话与两步验证留着，用被删凭证建立的会话会掉线。
  test('mesh.passkey.removed states both session outcomes', () => {
    setLang('en');
    const en = t('mesh.passkey.removed', { count: 2, username: 'bob' });
    expect(en).toContain('bob');
    expect(en).toContain('2');
    expect(en).toMatch(/two-step verification and password sessions stay/i);
    expect(en).toMatch(/signed out/i);
    expect(en).not.toMatch(/existing sessions are unchanged/i);
    setLang('zh-CN');
    const zh = t('mesh.passkey.removed', { count: 2, username: 'bob' });
    expect(zh).toContain('两步验证与密码会话保持不变');
    expect(zh).toContain('已注销');
    expect(zh).not.toContain('你');
    expect(zh).not.toContain('您');
  });

  test('upgrade.stunEnvMigrated and doctor.stun keys exist in both languages', () => {
    for (const lang of ['en', 'zh-CN'] as const) {
      setLang(lang);
      const migrated = t('upgrade.stunEnvMigrated', { backup: '/tmp/backups/app.env.x.stun' });
      expect(migrated).not.toBe('upgrade.stunEnvMigrated');
      expect(migrated).toContain('/tmp/backups/app.env.x.stun');
      expect(migrated).toContain('VIBETERM_STUN_SERVERS');
      for (const key of [
        'doctor.stun.builtin',
        'doctor.stun.custom',
        'doctor.stun.disabled',
      ] as const) {
        const message = t(key);
        expect(message).not.toBe(key);
        expect(message).toMatch(/STUN/i);
      }
    }
    setLang('zh-CN');
    expect(t('upgrade.stunEnvMigrated', { backup: 'x' })).not.toContain('你');
    expect(t('upgrade.stunEnvMigrated', { backup: 'x' })).not.toContain('您');
  });

  test('doctor.passkey origin hints exist in both languages', () => {
    for (const lang of ['en', 'zh-CN'] as const) {
      setLang(lang);
      for (const key of ['doctor.passkey.otherOrigin', 'doctor.passkey.otherOriginTotp'] as const) {
        const message = t(key, { origin: 'https://term.example.com' });
        expect(message).not.toBe(key);
        expect(message).toContain('vibeterm mesh passkey remove-all');
      }
    }
  });

  test('skipForeign exists in both languages and zh-CN avoids 你', () => {
    setLang('en');
    expect(t('cli.shim.skipForeign', { path: '/tmp/vibeterm' })).toContain('/tmp/vibeterm');
    setLang('zh-CN');
    const zh = t('cli.shim.skipForeign', { path: '/tmp/vibeterm' });
    expect(zh).toContain('/tmp/vibeterm');
    expect(zh).not.toContain('你');
  });
});
