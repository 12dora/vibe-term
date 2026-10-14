import { EC_MAX_SESSIONS } from '@vibeterm/shared/exec-channel';
import { attachExecChannelWith } from './connection';
import { realClock } from './deps';
import { resolveExecDevice } from './device-resolve';
import { spawnExecProcess } from './process';
import type { ExecChannelAuth, ExecChannelInbound, ExecTransport } from './transport-types';

const defaultDeps = {
  spawn: spawnExecProcess,
  resolveDevice: (ref: string | undefined) => resolveExecDevice(ref),
  clock: realClock,
  maxSessions: EC_MAX_SESSIONS,
};

export function attachExecChannel(
  transport: ExecTransport,
  auth: ExecChannelAuth
): ExecChannelInbound {
  return attachExecChannelWith(transport, auth, defaultDeps);
}
