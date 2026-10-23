// 传输流程单测的公共替身：可手动放行的上传桩、假 runtime。仅供测试引用。

import { ApiClient } from '@vibeterm/api-client';
import type { AppRuntime } from '@vibeterm/stores';

export interface UploadCall {
  nodeId: string;
  destDir: string;
  name: string;
  streams?: number;
}

interface PendingUpload {
  name: string;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** 每次上传都挂起，直到测试放行；同时记录调用与并发峰值。 */
export function createUploadStub() {
  const calls: UploadCall[] = [];
  const pending: PendingUpload[] = [];
  let inFlight = 0;
  let max = 0;
  const upload = async (
    nodeId: string,
    _rootId: string,
    destDir: string,
    file: File,
    opts: { streams?: number } = {}
  ) => {
    calls.push({ nodeId, destDir, name: file.name, streams: opts.streams });
    inFlight += 1;
    max = Math.max(max, inFlight);
    try {
      await new Promise<void>((resolve, reject) => {
        pending.push({ name: file.name, resolve, reject });
      });
    } finally {
      inFlight -= 1;
    }
    return 'relay';
  };
  return { upload, calls, pending, maxInFlight: () => max };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 反复放行挂起的上传直到 `promise` 结束；`failNames` 里的文件以错误结束。 */
export async function drainUploads(
  promise: Promise<void>,
  stub: ReturnType<typeof createUploadStub>,
  failNames: ReadonlySet<string> = new Set()
): Promise<void> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await tick();
  while (!settled) {
    for (const item of stub.pending.splice(0)) {
      if (failNames.has(item.name)) item.reject(new Error('disk is full'));
      else item.resolve();
    }
    await tick();
  }
}

export function fileOf(name: string, size = 10): File {
  return new File([new Uint8Array(size)], name);
}

export function fakeRuntime(
  nodeId = 'self',
  saveFile: (file: { name: string; blob: Blob }) => void | Promise<void> = () => {},
  fetchImpl: (path: string, init?: RequestInit) => Response | Promise<Response> = () =>
    new Response('{}', { headers: { 'Content-Type': 'application/json' } })
): AppRuntime {
  return {
    nodeId,
    apiClient: new ApiClient('', async (input, init) => fetchImpl(String(input), init)),
    host: { saveFile },
  } as unknown as AppRuntime;
}
