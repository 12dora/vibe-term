import { describe, expect, test } from 'bun:test';
import { loadWeixinIlink, loadWeixinService } from './lazy';

describe('weixin/lazy', () => {
  test('loadWeixinService memoizes the singleton', async () => {
    const first = await loadWeixinService();
    const second = await loadWeixinService();
    expect(first).toBe(second);
    expect(typeof first.weixinService.refresh).toBe('function');
  });

  test('loadWeixinIlink memoizes WeixinClient', async () => {
    const first = await loadWeixinIlink();
    const second = await loadWeixinIlink();
    expect(first).toBe(second);
    expect(typeof first.WeixinClient).toBe('function');
  });
});
