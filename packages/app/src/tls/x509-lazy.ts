import { createMemoizedLoader } from '../../../../apps/gateway/src/lazy-load';

const loader = createMemoizedLoader(async () => {
  const x509 = await import('@peculiar/x509');
  x509.cryptoProvider.set(crypto);
  return x509;
});

export function loadX509() {
  return loader.load();
}

export function peekX509() {
  return loader.peek();
}

export function resetX509LoaderForTests() {
  loader.reset();
}
