import { createMemoizedLoader } from '../lazy-load';
import { liveServicesStopping } from '../live-start-gates';
import { ensureMessagingHooks } from '../messaging/lazy-hooks';

const serviceLoader = createMemoizedLoader(() => import('./service'));
const ilinkLoader = createMemoizedLoader(() => import('./ilink/client'));

/** 消息运行时钩子随服务首次使用注册（live 启动后才生效），bot 处理命令前必须就位。 */
export async function loadWeixinService() {
  const mod = await serviceLoader.load();
  await ensureMessagingHooks();
  return mod;
}

export function peekWeixinService() {
  return serviceLoader.peek();
}

export function loadWeixinIlink() {
  return ilinkLoader.load();
}

let refreshing: Promise<void> = Promise.resolve();

/** 串行化 refresh；停机开始后加载完成的不再拉起轮询。stop 会等最后一次 refresh 落定。 */
export function refreshWeixinService(): Promise<void> {
  const run = refreshing.then(async () => {
    const { weixinService } = await loadWeixinService();
    if (!liveServicesStopping()) await weixinService.refresh();
  });
  refreshing = run.catch(() => undefined);
  return run;
}

export async function stopWeixinServiceIfLoaded() {
  await refreshing;
  const loaded = await serviceLoader.settled();
  if (loaded) await loaded.weixinService.stopAll();
}

export function resetWeixinLoadersForTests() {
  serviceLoader.reset();
  ilinkLoader.reset();
}
