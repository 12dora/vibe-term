import { test as setup } from '@playwright/test';
import { bootMesh } from './helpers/mesh-e2e';

setup('mesh: boot relay and nodes', async () => {
  setup.setTimeout(300_000);
  const state = await bootMesh();
  console.log(
    `[mesh] entry=${state.baseUrl} node=${state.remoteNodeName}(${state.remoteNodeId}) pid=${state.supervisorPid}`
  );
});
