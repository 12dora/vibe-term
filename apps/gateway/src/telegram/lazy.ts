import { createMemoizedLoader } from '../lazy-load';
import { liveServicesStopping } from '../live-start-gates';
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

let refreshing: Promise<void> = Promise.resolve();

/** 串行化 refresh；停机开始后加载完成的不再拉起轮询。stop 会等最后一次 refresh 落定。 */
export function refreshTelegramService(): Promise<void> {
  const run = refreshing.then(async () => {
    const { telegramService } = await loadTelegramService();
    if (!liveServicesStopping()) await telegramService.refresh();
  });
  refreshing = run.catch(() => undefined);
  return run;
}

export async function stopTelegramServiceIfLoaded() {
  await refreshing;
  const loaded = await serviceLoader.settled();
  if (loaded) await loaded.telegramService.stopAll();
}

export function resetTelegramLoadersForTests() {
  serviceLoader.reset();
  gramioLoader.reset();
}
