import { afterEach, describe, expect, test } from 'bun:test';
import { getAiTool, loadAiSdk, peekAiSdk, resetAiSdkLoadersForTests } from './ai-sdk-lazy';

afterEach(() => {
  resetAiSdkLoadersForTests();
});

describe('ai-sdk-lazy', () => {
  test('loadAiSdk memoizes and exposes tool()', async () => {
    expect(peekAiSdk()).toBeUndefined();
    const first = await loadAiSdk();
    const second = await loadAiSdk();
    expect(first).toBe(second);
    expect(typeof first.streamText).toBe('function');
    expect(typeof getAiTool()).toBe('function');
    expect(peekAiSdk()).toBe(first);
  });

  test('getAiTool throws before load', () => {
    expect(() => getAiTool()).toThrow('AI SDK is not loaded');
  });
});
