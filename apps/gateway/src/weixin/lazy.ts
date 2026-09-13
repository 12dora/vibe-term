import { createMemoizedLoader } from '../lazy-load';

const serviceLoader = createMemoizedLoader(() => import('./service'));
const ilinkLoader = createMemoizedLoader(() => import('./ilink/client'));

export function loadWeixinService() {
  return serviceLoader.load();
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
