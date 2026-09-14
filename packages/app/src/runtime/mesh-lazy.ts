import { createMemoizedLoader } from '../../../../apps/gateway/src/lazy-load';

const meshLoader = createMemoizedLoader(
  () => import('../../../../apps/gateway/src/mesh/mesh-runtime')
);

export function loadMeshRuntimeModule() {
  return meshLoader.load();
}

export function peekMeshRuntimeModule() {
  return meshLoader.peek();
}

export function resetMeshRuntimeLoaderForTests() {
  meshLoader.reset();
}
