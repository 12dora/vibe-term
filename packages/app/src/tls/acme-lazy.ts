import { createMemoizedLoader } from '../../../../apps/gateway/src/lazy-load';

const loader = createMemoizedLoader(() => import('acme-client'));

export function loadAcmeClient() {
  return loader.load();
}

export async function defaultAcmeClient(opts: {
  directoryUrl: string;
  accountKey: string;
  accountUrl?: string;
}) {
  return new (await loadAcmeClient()).Client(opts);
}

export function peekAcmeClient() {
  return loader.peek();
}

export function resetAcmeClientLoaderForTests() {
  loader.reset();
}
