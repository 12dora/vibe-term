import type { Device } from '@vibeterm/shared';
import type { ConnectConfig } from 'ssh2';

import type { decryptWithContext } from '../crypto';
import { createMemoizedLoader } from '../lazy-load';
import type { ResolveSshConnectConfigDeps } from './ssh-auth-resolvers';

const resolvers = createMemoizedLoader(() => import('./ssh-auth-resolvers'));

export type { ResolveSshConnectConfigDeps };

export async function resolveSshConnectConfig(
  device: Device,
  decrypt: typeof decryptWithContext,
  inputDeps: Partial<ResolveSshConnectConfigDeps> = {}
): Promise<ConnectConfig> {
  const {
    createSshConnectDeps,
    resolveAgentAuth,
    resolveAutoAuth,
    resolveConfigRefAuth,
    resolveKeyAuth,
    resolvePasswordAuth,
    resolveSshTarget,
  } = await resolvers.load();
  const deps = createSshConnectDeps(inputDeps);
  const target = resolveSshTarget(device, deps);
  const base: ConnectConfig = {
    host: target.host,
    port: target.port,
    username: target.username,
  };

  switch (device.authMode) {
    case 'password':
      return { ...base, ...(await resolvePasswordAuth(device, decrypt)) };
    case 'key':
      return { ...base, ...(await resolveKeyAuth(device, decrypt)) };
    case 'agent':
      return { ...base, ...resolveAgentAuth(target) };
    case 'configRef':
      return { ...base, ...resolveConfigRefAuth(target) };
    case 'auto':
      return { ...base, ...(await resolveAutoAuth(device, target, decrypt)) };
  }
}
