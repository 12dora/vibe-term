import { test as teardown } from '@playwright/test';
import { stopMesh } from './helpers/mesh';

teardown('mesh: stop hub and node', async () => {
  teardown.setTimeout(60_000);
  await stopMesh();
});
