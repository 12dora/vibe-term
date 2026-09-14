import { describe, expect, test } from 'bun:test';
import { reportAdmitResult } from './use-admit-node';

const t = (key: string) => key;

describe('reportAdmitResult', () => {
  test('node_id_reused 按已加入处理：刷新列表，不再报错', () => {
    // 上一次「确认」其实已经落账，这个标签页只是没看到结果。再报一次错只会让用户
    // 反复点确认，而成员密钥永远补不上（round40 live incident）。
    expect(reportAdmitResult(t, { kind: 'error', code: 'node_id_reused' })).toBe(true);
  });

  test('其余错误码照常报失败，不刷新', () => {
    expect(reportAdmitResult(t, { kind: 'error', code: 'seq_gap' })).toBe(false);
  });

  test('已批准 / 未确认 / 作废各自的结论不变', () => {
    expect(reportAdmitResult(t, { kind: 'admitted' })).toBe(true);
    expect(reportAdmitResult(t, { kind: 'unconfirmed' })).toBe(false);
    expect(reportAdmitResult(t, { kind: 'stale' })).toBe(false);
  });
});
