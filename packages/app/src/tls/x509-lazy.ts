import { createMemoizedLoader } from '../../../../apps/gateway/src/lazy-load';

const loader = createMemoizedLoader(async () => {
  // tsyringe 需要 Reflect 元数据 polyfill，必须先于 @peculiar/x509 求值
  await import('reflect-metadata');
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
