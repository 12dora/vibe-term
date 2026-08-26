import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { useBellStore } from './bell-store';

describe('useBellStore', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    useBellStore.setState({ ringingPanes: {} });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('1.5s 内的第二次响铃按自身时间线计时，不被前一个定时器提前清除', () => {
    const { triggerBell } = useBellStore.getState();

    triggerBell('%1');
    jest.advanceTimersByTime(1000);
    triggerBell('%1');

    jest.advanceTimersByTime(600);
    expect(useBellStore.getState().ringingPanes['%1']).toBe(true);

    jest.advanceTimersByTime(1000);
    expect(useBellStore.getState().ringingPanes['%1']).toBeUndefined();
  });

  test('clearBell 后的新响铃不会被上一次响铃的过期定时器清除', () => {
    const { triggerBell, clearBell } = useBellStore.getState();

    triggerBell('%2');
    jest.advanceTimersByTime(1000);
    clearBell('%2');
    expect(useBellStore.getState().ringingPanes['%2']).toBeUndefined();

    jest.advanceTimersByTime(400);
    triggerBell('%2');
    jest.advanceTimersByTime(200);
    expect(useBellStore.getState().ringingPanes['%2']).toBe(true);

    jest.advanceTimersByTime(1400);
    expect(useBellStore.getState().ringingPanes['%2']).toBeUndefined();
  });

  test('单次响铃仍在 1.5s 后自动结束', () => {
    useBellStore.getState().triggerBell('%3');
    jest.advanceTimersByTime(1499);
    expect(useBellStore.getState().ringingPanes['%3']).toBe(true);
    jest.advanceTimersByTime(2);
    expect(useBellStore.getState().ringingPanes['%3']).toBeUndefined();
  });
});
