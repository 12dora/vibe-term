import { describe, expect, test } from 'bun:test';
import { loadMeshRuntimeModule } from './mesh-lazy';

describe('mesh-lazy', () => {
  test('loadMeshRuntimeModule memoizes createMeshRuntime', async () => {
    const first = await loadMeshRuntimeModule();
    const second = await loadMeshRuntimeModule();
    expect(first).toBe(second);
    expect(typeof first.createMeshRuntime).toBe('function');
  });
});
