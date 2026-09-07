import './test-master-key';
import { expect, test } from 'bun:test';
import {
  bootRelayMeshHarness,
  waitRelayKeyLogSynced,
} from '../../../../apps/gateway/src/relay/integration/relay-mesh-harness';
import { keyLogStatusVerdict } from '../commands/mesh';
import { withRuntimeDiagnostics } from '../runtime/assemble-diagnostics';
import type { AssembledFetch } from '../runtime/assemble-routes';
import { createAuthContextFromDb } from './local-auth';

test('relay keylog diagnostics decrypts the in-memory relay head and reports IN_SYNC', async () => {
  const h = await bootRelayMeshHarness();
  try {
    const tenant = await h.createTenant('relay-diagnostics');
    await tenant.enroll();
    await waitRelayKeyLogSynced(h, tenant);
    const node = tenant.owner;
    const auth = await createAuthContextFromDb(node.db);
    const dispatch = withRuntimeDiagnostics(async () => undefined, auth, node.mesh, null);
    const response = await dispatch(new Request('http://localhost/api/mesh/keylog/status'), {
      requestIP: () => ({ address: '127.0.0.1' }),
    } as unknown as Parameters<AssembledFetch>[1]);
    const status = await response!.json();
    expect(status.remoteKind).toBe('relay');
    expect(status.remote).toEqual(status.local);
    expect(status.error).toBeUndefined();
    expect(keyLogStatusVerdict(status)).toBe('IN_SYNC');
    expect(await node.relayClient()!.queryHubHead()).toEqual(auth.keyLogStore.head(tenant.userId));
  } finally {
    await h.stop();
  }
}, 15_000);
