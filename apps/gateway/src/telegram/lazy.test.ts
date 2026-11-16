import { afterEach, describe, expect, test } from 'bun:test';
import { markLiveServicesStopping, setLiveServicesEnabled } from '../live-start-gates';
import {
  loadGramio,
  loadTelegramService,
  refreshTelegramService,
  resetTelegramLoadersForTests,
  stopTelegramServiceIfLoaded,
} from './lazy';
import { telegramService } from './service';

afterEach(() => {
  setLiveServicesEnabled(false);
});

function stubService(calls: string[]): () => void {
  const original = { refresh: telegramService.refresh, stopAll: telegramService.stopAll };
  telegramService.refresh = async () => {
    calls.push('refresh');
  };
  telegramService.stopAll = async () => {
    calls.push('stopAll');
  };
  return () => {
    telegramService.refresh = original.refresh;
    telegramService.stopAll = original.stopAll;
  };
}

describe('telegram/lazy', () => {
  test('loadTelegramService memoizes the singleton', async () => {
    const first = await loadTelegramService();
    const second = await loadTelegramService();
    expect(first).toBe(second);
    expect(typeof first.telegramService.refresh).toBe('function');
  });

  test('loadGramio memoizes Bot and propagates as a constructor', async () => {
    const first = await loadGramio();
    const second = await loadGramio();
    expect(first).toBe(second);
    expect(typeof first.Bot).toBe('function');
  });

  test('shutdown during the first load: stop waits and no polling starts', async () => {
    const calls: string[] = [];
    const restore = stubService(calls);
    try {
      resetTelegramLoadersForTests();
      setLiveServicesEnabled(true);
      const refreshing = refreshTelegramService();
      markLiveServicesStopping();
      await stopTelegramServiceIfLoaded();
      await refreshing;
      expect(calls).toEqual(['stopAll']);

      setLiveServicesEnabled(true);
      await Promise.all([refreshTelegramService(), refreshTelegramService()]);
      expect(calls).toEqual(['stopAll', 'refresh', 'refresh']);
    } finally {
      restore();
    }
  });
});
