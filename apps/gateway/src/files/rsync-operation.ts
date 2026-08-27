import type { Device, FileErrorCode } from '@tmex/shared';
import { enqueueDeviceJob } from './queue';
import { RsyncAuthError, type RsyncDeviceSpec, buildRsyncDeviceSpec } from './ssh-command';

export type FileOpResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: FileErrorCode; detail?: string };

export function ok<T>(data: T): FileOpResult<T> {
  return { ok: true, data };
}

export function fail(
  code: FileErrorCode,
  detail?: string
): { ok: false; code: FileErrorCode; detail?: string } {
  return { ok: false, code, detail };
}

export interface DeviceRsyncHooks {
  enqueue?: typeof enqueueDeviceJob;
  buildSpec?: typeof buildRsyncDeviceSpec;
}

export async function withDeviceRsync<T>(
  device: Device,
  fn: (spec: RsyncDeviceSpec) => Promise<FileOpResult<T>>,
  hooks: DeviceRsyncHooks = {}
): Promise<FileOpResult<T>> {
  const enqueue = hooks.enqueue ?? enqueueDeviceJob;
  const buildSpec = hooks.buildSpec ?? buildRsyncDeviceSpec;
  return enqueue(device.id, async () => {
    let spec: Awaited<ReturnType<typeof buildSpec>>;
    try {
      spec = await buildSpec(device);
    } catch (error) {
      if (error instanceof RsyncAuthError) return fail(error.code, error.message);
      throw error;
    }
    try {
      return await fn(spec);
    } finally {
      spec.cleanup();
    }
  });
}
