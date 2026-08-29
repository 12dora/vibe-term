import { describe, expect, test } from 'bun:test';
import { cleanTerminalText } from './run-command';
import {
  buildSendInputPayload,
  formatEmulatorResult,
  formatFallbackResult,
} from './send-input-payload';
import { encodeCombo } from './terminal-encoding';
import { wrapUntrusted } from './untrusted';

const capturedAt = '2026-08-30T00:00:00.000Z';
const RAW_IGNORED_WARNING =
  'rawControlChars was ignored because the session does not allow control characters; use combos (e.g. ctrl+c) instead.';

describe('buildSendInputPayload', () => {
  test('按 text → combos → keys → rawControlChars 顺序拼接', () => {
    const { data, warnings } = buildSendInputPayload({
      text: 'ls',
      combos: [{ modifiers: ['ctrl'], key: 'c' }, { key: 'enter' }],
      keys: ['ctrl_d', 'tab'],
      rawControlChars: '\x1a',
      allowControlChars: true,
    });
    expect(data).toBe(
      `ls${encodeCombo({ modifiers: ['ctrl'], key: 'c' })}${encodeCombo({ key: 'enter' })}\x04\t\x1a`
    );
    expect(warnings).toEqual([]);
  });

  test('未允许控制字符时忽略 rawControlChars 并给出 warning；缺省字段视为空', () => {
    const ignored = buildSendInputPayload({
      rawControlChars: '\x03',
      allowControlChars: false,
    });
    expect(ignored.data).toBe('');
    expect(ignored.warnings).toEqual([RAW_IGNORED_WARNING]);

    const empty = buildSendInputPayload({ allowControlChars: true });
    expect(empty).toEqual({ data: '', warnings: [] });
  });

  test('允许控制字符时不产生 warning，即使 rawControlChars 为空串', () => {
    expect(
      buildSendInputPayload({
        text: 'x',
        rawControlChars: '',
        allowControlChars: false,
      })
    ).toEqual({ data: 'x', warnings: [] });

    expect(
      buildSendInputPayload({
        text: 'x',
        rawControlChars: '\x03',
        allowControlChars: true,
      })
    ).toEqual({ data: 'x\x03', warnings: [] });
  });
});

describe('formatEmulatorResult', () => {
  const size = { cols: 100, rows: 30 };
  const info = { cols: 80, rows: 24, cursorX: 3, cursorY: 5 };

  test('alternate screen 返回完整渲染态并包裹 untrusted', () => {
    const result = formatEmulatorResult({
      alternateScreen: true,
      screen: 'vim buffer',
      deltaBytes: new TextEncoder().encode('should-not-appear'),
      info,
      emulatorSize: size,
      warnings: [],
      capturedAt,
    });
    expect(result).toEqual({
      screen: wrapUntrusted('vim buffer', 'terminal'),
      mode: 'screen',
      cols: 80,
      rows: 24,
      cursorX: 3,
      cursorY: 5,
      capturedAt,
    });
    expect('warnings' in result).toBe(false);
    expect('delta' in result).toBe(false);
  });

  test('行模式解码 tap 字节、清洗控制序列，pane info 缺失时回退 emulator 尺寸', () => {
    const result = formatEmulatorResult({
      alternateScreen: false,
      screen: 'unused',
      deltaBytes: new TextEncoder().encode('\x1b[31mhello from pane\x1b[0m\n'),
      info: null,
      emulatorSize: size,
      warnings: [RAW_IGNORED_WARNING],
      capturedAt,
    });
    expect(result.mode).toBe('delta');
    if (result.mode === 'delta') {
      expect(result.delta).toBe(
        wrapUntrusted(cleanTerminalText('\x1b[31mhello from pane\x1b[0m\n'), 'terminal')
      );
    }
    expect(result.cols).toBe(100);
    expect(result.rows).toBe(30);
    expect(result.cursorX).toBeNull();
    expect(result.cursorY).toBeNull();
    expect(result.warnings).toHaveLength(1);
  });
});

describe('formatFallbackResult', () => {
  test('截取清洗后的末 15 行并包裹 untrusted；无 warnings 时不带该字段', () => {
    const screen = `${Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n')}\n\n`;
    const result = formatFallbackResult({
      screen,
      info: { cols: 80, rows: 24 },
      warnings: [],
      capturedAt,
    });
    const inner = result.screenTail.split('\n').slice(1, -1);
    expect(result.screenTail.startsWith('<<<UNTRUSTED TERMINAL SCREEN')).toBe(true);
    expect(inner).toEqual(Array.from({ length: 15 }, (_, i) => `line${i + 6}`));
    expect(result.cols).toBe(80);
    expect(result.rows).toBe(24);
    expect('warnings' in result).toBe(false);
    expect(result.capturedAt).toBe(capturedAt);
  });

  test('pane info 失败时尺寸为 null，并透传 warnings', () => {
    const result = formatFallbackResult({
      screen: 'only',
      info: null,
      warnings: [RAW_IGNORED_WARNING],
      capturedAt,
    });
    expect(result.screenTail).toContain('only');
    expect(result.cols).toBeNull();
    expect(result.rows).toBeNull();
    expect(result.warnings).toHaveLength(1);
  });
});
