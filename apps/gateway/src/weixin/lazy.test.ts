import { afterEach, describe, expect, test } from 'bun:test';
import { markLiveServicesStopping, setLiveServicesEnabled } from '../live-start-gates';
import {
  loadWeixinIlink,
  loadWeixinService,
  refreshWeixinService,
  resetWeixinLoadersForTests,
  stopWeixinServiceIfLoaded,
} from './lazy';
import { weixinService } from './service';

afterEach(() => {
  setLiveServicesEnabled(false);
});

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

  test('shutdown during the first load: stop waits and no polling starts', async () => {
    const calls: string[] = [];
    const original = { refresh: weixinService.refresh, stopAll: weixinService.stopAll };
    weixinService.refresh = async () => {
      calls.push('refresh');
    };
    weixinService.stopAll = async () => {
      calls.push('stopAll');
    };
    try {
      resetWeixinLoadersForTests();
      setLiveServicesEnabled(true);
      const refreshing = refreshWeixinService();
      markLiveServicesStopping();
      await stopWeixinServiceIfLoaded();
      await refreshing;
      expect(calls).toEqual(['stopAll']);
    } finally {
      weixinService.refresh = original.refresh;
      weixinService.stopAll = original.stopAll;
    }
  });
});
