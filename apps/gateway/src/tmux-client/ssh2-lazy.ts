import { createMemoizedLoader } from '../lazy-load';

const loader = createMemoizedLoader(() => import('ssh2'));

export function loadSsh2() {
  return loader.load();
}

export function peekSsh2() {
  return loader.peek();
}

export function resetSsh2LoaderForTests() {
  loader.reset();
}
