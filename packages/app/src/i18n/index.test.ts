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
    expect(t('cli.help')).toContain('tmex direct enable|disable');
    setLang('zh-CN');
    expect(t('cli.help')).toBe(cliHelpText('zh-CN'));
    expect(t('cli.help')).toContain('tmex hub join');
  });
});
