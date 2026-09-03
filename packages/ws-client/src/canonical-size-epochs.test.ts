import { describe, expect, test } from 'bun:test';
import { CanonicalSizeEpochs } from './canonical-size-epochs';
import { paneKey } from './canonical-state-helpers';

describe('CanonicalSizeEpochs', () => {
  test('change 单调递增，resend 复用该 pane 上一次的值', () => {
    const epochs = new CanonicalSizeEpochs();
    expect(epochs.change('dev', '%1')).toBe(1n);
    expect(epochs.change('dev', '%2')).toBe(2n);
    expect(epochs.resend('dev', '%1')).toBe(1n);
    expect(epochs.change('dev', '%1')).toBe(3n);
    expect(epochs.resend('dev', '%1')).toBe(3n);
  });

  test('没有过真实变化的 pane 补发不落 0（0 是编码侧保留值）', () => {
    const epochs = new CanonicalSizeEpochs();
    expect(epochs.resend('dev', '%9')).toBe(1n);
  });

  test('dropPane 删掉条目但计数器不回退', () => {
    const epochs = new CanonicalSizeEpochs();
    epochs.change('dev', '%1');
    expect(epochs.change('dev', '%2')).toBe(2n);
    expect(epochs.dropPane('dev', '%1')).toBe(true);
    expect(epochs.dropPane('dev', '%1')).toBe(false);
    expect([...epochs.keys()]).toEqual([paneKey('dev', '%2')]);
    // 同名 pane 重新出现仍拿到更大的 epoch，网关侧的单调过滤不会误丢
    expect(epochs.change('dev', '%1')).toBe(3n);
  });

  test('clear 清空全部条目', () => {
    const epochs = new CanonicalSizeEpochs();
    epochs.change('dev', '%1');
    epochs.clear();
    expect([...epochs.keys()]).toEqual([]);
  });
});
