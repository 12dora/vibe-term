import { describe, expect, test } from 'bun:test';
import { loadHubRuntimeModule, loadMeshRuntimeModule } from './hub-lazy';

describe('hub-lazy', () => {
  test('loadHubRuntimeModule memoizes HubRuntime', async () => {
    const first = await loadHubRuntimeModule();
    const second = await loadHubRuntimeModule();
    expect(first).toBe(second);
    expect(typeof first.HubRuntime).toBe('function');
  });

  test('loadMeshRuntimeModule memoizes createMeshRuntime', async () => {
    const first = await loadMeshRuntimeModule();
    const second = await loadMeshRuntimeModule();
    expect(first).toBe(second);
    expect(typeof first.createMeshRuntime).toBe('function');
  });
});
