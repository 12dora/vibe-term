import { createMemoizedLoader } from '../lazy-load';
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

export async function refreshWeixinService() {
  const { weixinService } = await loadWeixinService();
  return weixinService.refresh();
}

export async function stopWeixinServiceIfLoaded() {
  const loaded = peekWeixinService();
  if (loaded) await loaded.weixinService.stopAll();
}

export function resetWeixinLoadersForTests() {
  serviceLoader.reset();
  ilinkLoader.reset();
}
