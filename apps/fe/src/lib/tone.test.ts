import { describe, expect, test } from 'bun:test';
import { TONE_CLASS, toneClass } from './tone';

describe('TONE_CLASS', () => {
  test('badge 三档与链路徽标原 class 一致', () => {
    expect(TONE_CLASS.badge.ok).toBe(
      'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
    );
    expect(TONE_CLASS.badge.warn).toBe('border-orange-400/40 text-orange-500 dark:text-orange-400');
    expect(TONE_CLASS.badge.muted).toBe('border-border text-muted-foreground');
  });

  test('dot 三档与端口灯原 class 一致', () => {
    expect(TONE_CLASS.dot.ok).toBe('bg-emerald-500');
    expect(TONE_CLASS.dot.blocked).toBe('bg-destructive');
    expect(TONE_CLASS.dot.muted).toBe('bg-muted-foreground/40');
  });

  test('chip 三档与中继 TURN 芯片原 class 一致', () => {
    expect(TONE_CLASS.chip.blocked).toBe('border-destructive/40 text-destructive');
    expect(TONE_CLASS.chip.warn).toBe('border-amber-500/40 text-amber-700 dark:text-amber-400');
    expect(TONE_CLASS.chip.muted).toBe('border-border');
  });

  test('text 档与状态 / 反馈 / RTT 原 class 一致', () => {
    expect(TONE_CLASS.text.ok).toBe('text-emerald-500');
    expect(TONE_CLASS.text.warn).toBe('text-amber-600 dark:text-amber-400');
    expect(TONE_CLASS.text.muted).toBe('text-muted-foreground');
    expect(TONE_CLASS.text.blocked).toBe('text-destructive');
  });

  test('notice 与 form-primitives 原 class 一致', () => {
    expect(TONE_CLASS.notice.info).toBe('bg-muted/60 text-muted-foreground');
    expect(TONE_CLASS.notice.ok).toBe('bg-primary/10 text-primary');
    expect(TONE_CLASS.notice.warn).toBe('bg-amber-500/10 text-amber-600 dark:text-amber-400');
    expect(TONE_CLASS.notice.blocked).toBe('bg-destructive/10 text-destructive');
  });

  test('cardNotice 与 card-parts 原 class 一致（warning 用 amber-700）', () => {
    expect(TONE_CLASS.cardNotice.blocked).toBe('bg-destructive/10 text-destructive');
    expect(TONE_CLASS.cardNotice.warn).toBe('bg-amber-500/10 text-amber-700 dark:text-amber-400');
    expect(TONE_CLASS.cardNotice.muted).toBe('bg-muted/60 text-muted-foreground');
  });

  test('toneClass 按表面取值', () => {
    expect(toneClass('badge', 'ok')).toBe(TONE_CLASS.badge.ok);
    expect(toneClass('dot', 'blocked')).toBe(TONE_CLASS.dot.blocked);
    expect(toneClass('text', 'warn')).toBe(TONE_CLASS.text.warn);
  });
});
