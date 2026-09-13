import { createMemoizedLoader } from '../../../../apps/gateway/src/lazy-load';

const loader = createMemoizedLoader(
  () => import('../../../../apps/gateway/src/relay/relay-runtime')
);

export function loadRelayRuntime() {
  return loader.load();
}

export function peekRelayRuntime() {
  return loader.peek();
}

export function resetRelayRuntimeLoaderForTests() {
  loader.reset();
}
