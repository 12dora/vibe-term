import { describe, expect, test } from 'bun:test';
import { loadGramio, loadTelegramService } from './lazy';

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
});
