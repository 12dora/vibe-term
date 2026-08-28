import { test as setup } from '@playwright/test';
import { bootMesh } from './helpers/mesh';

setup('mesh: boot hub and node', async () => {
  setup.setTimeout(300_000);
  const state = await bootMesh();
  console.log(
    `[mesh] hub=${state.baseUrl} node=${state.remoteNodeName}(${state.remoteNodeId}) pid=${state.supervisorPid}`
  );
});
