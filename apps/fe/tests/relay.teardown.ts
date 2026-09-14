import { test as teardown } from '@playwright/test';
import { stopMesh } from './helpers/mesh-e2e';

teardown('mesh: stop relay and nodes', async () => {
  teardown.setTimeout(60_000);
  await stopMesh();
});
