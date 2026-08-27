import type { Device } from '@tmex/shared';
import type { ConnectConfig } from 'ssh2';

import type { decryptWithContext } from '../crypto';
import {
  type ResolveSshConnectConfigDeps,
  createSshConnectDeps,
  resolveAgentAuth,
  resolveAutoAuth,
  resolveConfigRefAuth,
  resolveKeyAuth,
  resolvePasswordAuth,
  resolveSshTarget,
} from './ssh-auth-resolvers';

export type { ResolveSshConnectConfigDeps };

export async function resolveSshConnectConfig(
  device: Device,
  decrypt: typeof decryptWithContext,
  inputDeps: Partial<ResolveSshConnectConfigDeps> = {}
): Promise<ConnectConfig> {
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
