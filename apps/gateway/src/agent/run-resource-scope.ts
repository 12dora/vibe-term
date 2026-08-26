import type { EmulatorStreamSource, PaneEmulator } from '../tmux-client/pane-emulator';
import { PaneEmulatorRegistry } from '../tmux-client/pane-emulator';
import type { TerminalRuntimeLike } from './tools/terminal-context';

/** 全局 per-pane 模拟器池（引用计数复用 + 显式 free，见 pane-emulator.ts）。 */
export const paneEmulatorRegistry = new PaneEmulatorRegistry();

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** runtime 是否具备模拟器所需的流订阅能力（stub runtime 没有则退回 capture）。 */
export function asEmulatorSource(runtime: unknown): EmulatorStreamSource | null {
  const candidate = runtime as Partial<EmulatorStreamSource>;
  return typeof candidate?.subscribe === 'function' &&
    typeof candidate?.capturePaneText === 'function' &&
    typeof candidate?.getPaneInfo === 'function'
    ? (candidate as EmulatorStreamSource)
    : null;
}

export interface AcquireRunResourcesParams {
  deviceId: string | null;
  paneId: string | null;
  acquireRuntime: (deviceId: string) => Promise<TerminalRuntimeLike>;
  acquireEmulator?: (
    deviceId: string,
    paneId: string,
    source: EmulatorStreamSource
  ) => Promise<PaneEmulator>;
}

export interface AcquiredRunResources {
  runtime: TerminalRuntimeLike | null;
  emulator: PaneEmulator | null;
  runtimeError: string | null;
}

export async function acquireRunResources(
  params: AcquireRunResourcesParams
): Promise<AcquiredRunResources> {
  const acquireEmulator =
    params.acquireEmulator ??
    ((deviceId, paneId, source) => paneEmulatorRegistry.acquire(deviceId, paneId, source));

  if (!params.deviceId || !params.paneId) {
    return { runtime: null, emulator: null, runtimeError: null };
  }

  let runtime: TerminalRuntimeLike;
  try {
    runtime = await params.acquireRuntime(params.deviceId);
  } catch (error) {
    return {
      runtime: null,
      emulator: null,
      runtimeError: `failed to acquire terminal runtime: ${toErrorMessage(error)}`,
    };
  }

  let emulator: PaneEmulator | null = null;
  const source = asEmulatorSource(runtime);
  if (source) {
    try {
      emulator = await acquireEmulator(params.deviceId, params.paneId, source);
    } catch (error) {
      console.error(`[agent-run] failed to acquire pane emulator: ${toErrorMessage(error)}`);
      emulator = null;
    }
  }

  return { runtime, emulator, runtimeError: null };
}

export interface ReleaseRunResourcesParams {
  emulator: PaneEmulator | null;
  runtime: TerminalRuntimeLike | null;
  deviceId: string | null;
  paneId: string | null;
  releaseRuntime: (deviceId: string, runtime?: TerminalRuntimeLike) => Promise<void>;
  releaseEmulator?: (deviceId: string, paneId: string) => Promise<void>;
  destroyEmulator?: (deviceId: string, paneId: string) => Promise<void>;
}

/**
 * 释放顺序必须保持：emulator release → emulator destroy → runtime release。
 * 调用方应在传入前把 live emulator 引用置空，避免并发 fatal destroy 双重释放。
 */
export async function releaseRunResources(params: ReleaseRunResourcesParams): Promise<void> {
  const releaseEmulator =
    params.releaseEmulator ??
    ((deviceId, paneId) => paneEmulatorRegistry.release(deviceId, paneId));
  const destroyEmulator =
    params.destroyEmulator ??
    ((deviceId, paneId) => paneEmulatorRegistry.destroy(deviceId, paneId));

  if (params.emulator && params.deviceId && params.paneId) {
    try {
      await releaseEmulator(params.deviceId, params.paneId);
    } catch (error) {
      console.error('[agent-run] failed to release pane emulator:', error);
    }
    try {
      await destroyEmulator(params.deviceId, params.paneId);
    } catch (error) {
      console.error('[agent-run] failed to destroy pane emulator:', error);
    }
  }

  if (params.runtime && params.deviceId) {
    try {
      await params.releaseRuntime(params.deviceId, params.runtime);
    } catch (error) {
      console.error(`[agent-run] failed to release runtime ${params.deviceId}:`, error);
    }
  }
}

export function destroyPaneEmulator(deviceId: string, paneId: string): Promise<void> {
  return paneEmulatorRegistry.destroy(deviceId, paneId);
}
