import { createMemoizedLoader } from '../lazy-load';
import { ensureMessagingHooks } from '../messaging/lazy-hooks';

const serviceLoader = createMemoizedLoader(() => import('./service'));
const gramioLoader = createMemoizedLoader(() => import('gramio'));

/** 消息运行时钩子随服务首次使用注册（live 启动后才生效），bot 处理命令前必须就位。 */
export async function loadTelegramService() {
  const mod = await serviceLoader.load();
  await ensureMessagingHooks();
  return mod;
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
