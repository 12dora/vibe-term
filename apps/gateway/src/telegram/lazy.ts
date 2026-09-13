import { createMemoizedLoader } from '../lazy-load';

const serviceLoader = createMemoizedLoader(() => import('./service'));
const gramioLoader = createMemoizedLoader(() => import('gramio'));

export function loadTelegramService() {
  return serviceLoader.load();
}

export function peekTelegramService() {
  return serviceLoader.peek();
}

export function loadGramio() {
  return gramioLoader.load();
}

export async function refreshTelegramService() {
  const { telegramService } = await loadTelegramService();
  return telegramService.refresh();
}

export async function stopTelegramServiceIfLoaded() {
  const loaded = peekTelegramService();
  if (loaded) await loaded.telegramService.stopAll();
}

export function resetTelegramLoadersForTests() {
  serviceLoader.reset();
  gramioLoader.reset();
}
