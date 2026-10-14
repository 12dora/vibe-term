import { EC_MAX_SESSIONS } from '@vibeterm/shared/exec-channel';
import { getMeshNotificationBridge } from '../../mesh/notification-mesh-bridge';
import { attachExecChannelWith } from './connection';
import { execCredentialValid } from './credential-check';
import { realClock } from './deps';
import { resolveExecDevice } from './device-resolve';
import { spawnExecProcess } from './process';
import type { ExecChannelAuth, ExecChannelInbound, ExecTransport } from './transport-types';

const defaultDeps = {
  spawn: spawnExecProcess,
  resolveDevice: (ref: string | undefined) => resolveExecDevice(ref),
  selfNodeName: () => getMeshNotificationBridge()?.selfName() ?? null,
  clock: realClock,
  maxSessions: EC_MAX_SESSIONS,
  credentialValid: execCredentialValid,
};

export function attachExecChannel(
  transport: ExecTransport,
  auth: ExecChannelAuth
): ExecChannelInbound {
  return attachExecChannelWith(transport, auth, defaultDeps);
}
