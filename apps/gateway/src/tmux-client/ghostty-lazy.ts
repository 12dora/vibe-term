import { createMemoizedLoader } from '../lazy-load';

const loader = createMemoizedLoader(() => import('ghostty-terminal/headless'));

export function loadGhosttyHeadless() {
  return loader.load();
}

export function peekGhosttyHeadless() {
  return loader.peek();
}

export function resetGhosttyHeadlessLoaderForTests() {
  loader.reset();
}
