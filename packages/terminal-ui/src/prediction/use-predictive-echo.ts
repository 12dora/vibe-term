import type { AppRuntime, PredictiveEchoMode } from '@vibeterm/stores';
import { useRuntime, useTmuxStore, useUIStore } from '@vibeterm/stores/react';
import type { DirectDiagnostics } from '@vibeterm/ws-client/direct/types';
import type { CompatibleTerminalLike, TerminalPredictionHost } from 'ghostty-terminal';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { TerminalProps } from '../components/types';
import { nextAutoActive } from './activation';
import type { PredictiveEchoController } from './controller';

type ControllerRef = RefObject<PredictiveEchoController | null>;
type SendInput = (deviceId: string, paneId: string, data: string, isComposing?: boolean) => void;

/** 浏览器 ↔ node 的链路 RTT：直连时取 ICE 选中候选对 RTT，否则取心跳中位数 */
export function pickLinkRttMs(
  direct: Pick<DirectDiagnostics, 'path' | 'rtt'> | null,
  heartbeatMs: number | null
): number | null {
  if (direct?.path === 'direct' && typeof direct.rtt === 'number' && Number.isFinite(direct.rtt)) {
    return direct.rtt;
  }
  return typeof heartbeatMs === 'number' && Number.isFinite(heartbeatMs) ? heartbeatMs : null;
}

export function readLinkRttMs(
  runtime: Pick<AppRuntime, 'transport' | 'directDiagnostics'>
): number | null {
  return pickLinkRttMs(runtime.directDiagnostics?.().get() ?? null, runtime.transport.latencyMs);
}

/** 订阅 RTT 采样（心跳 / 直连诊断），立即回调一次；返回退订 */
export function watchLinkRtt(
  runtime: Pick<AppRuntime, 'transport' | 'directDiagnostics'>,
  onSample: (rttMs: number | null) => void
): () => void {
  const emit = (): void => onSample(readLinkRttMs(runtime));
  const offTransport = runtime.transport.onEvent((event) => {
    if (event.type === 'latency' || event.type === 'connection-state') emit();
  });
  const offDirect = runtime.directDiagnostics?.().subscribe(emit);
  emit();
  return () => {
    offTransport();
    offDirect?.();
  };
}

const paneControllers = new WeakMap<object, Map<string, Set<ControllerRef>>>();

function paneKey(deviceId: string, paneId: string): string {
  return `${deviceId}\u0000${paneId}`;
}

export function registerPanePrediction(
  runtime: object,
  deviceId: string,
  paneId: string,
  ref: ControllerRef
): () => void {
  const key = paneKey(deviceId, paneId);
  let panes = paneControllers.get(runtime);
  if (!panes) {
    panes = new Map();
    paneControllers.set(runtime, panes);
  }
  const refs = panes.get(key) ?? new Set<ControllerRef>();
  refs.add(ref);
  panes.set(key, refs);
  return () => {
    refs.delete(ref);
    if (refs.size === 0) panes.delete(key);
  };
}

/** 绕过终端 onData 直接发往 pane 的输入（快捷键栏等）也要告知预测回显 */
export function notePaneInput(
  runtime: object,
  deviceId: string,
  paneId: string,
  data: string,
  paste = false
): void {
  for (const ref of paneControllers.get(runtime)?.get(paneKey(deviceId, paneId)) ?? []) {
    ref.current?.noteInput(data, paste);
  }
}

const pastingInstances = new WeakSet<object>();

/** 宿主侧发起的粘贴：期间经 onData 发出的字节不做预测 */
export function pasteWithoutPrediction(instance: CompatibleTerminalLike, text: string): void {
  pastingInstances.add(instance);
  try {
    instance.paste(text);
  } finally {
    pastingInstances.delete(instance);
  }
}

interface ControllerStart {
  host: TerminalPredictionHost;
  textarea: HTMLElement | null;
  runtime: AppRuntime;
  rttRef: RefObject<number | null>;
  controllerRef: ControllerRef;
}

/** 引擎与控制器按需加载：只有预测真正激活才拉这块代码，入口包里只留激活判定 */
function startController({ host, textarea, runtime, rttRef, controllerRef }: ControllerStart) {
  let disposed = false;
  let stop: (() => void) | null = null;
  import('./controller')
    .then(({ PredictiveEchoController }) => {
      if (disposed) return;
      const controller = new PredictiveEchoController({ host, textarea });
      controller.setRttMs(rttRef.current);
      controller.setActive(true);
      controllerRef.current = controller;
      const offTransport = runtime.transport.onEvent((event) => {
        if (event.type === 'connection-state' && event.state !== 'READY') controller.reset();
      });
      stop = () => {
        offTransport();
        controller.dispose();
        if (controllerRef.current === controller) controllerRef.current = null;
      };
    })
    .catch(() => undefined);
  return () => {
    disposed = true;
    stop?.();
  };
}

/**
 * RTT 只经 ref 流动，Terminal 不随每个采样重渲染；auto 的开关结果翻转时才 setState。
 */
function useLinkActivation(
  runtime: AppRuntime,
  eligible: boolean,
  rttRef: RefObject<number | null>,
  controllerRef: ControllerRef
): boolean {
  const [autoActive, setAutoActive] = useState(false);
  const autoRef = useRef(false);
  useEffect(() => {
    if (!eligible) return;
    return watchLinkRtt(runtime, (rttMs) => {
      rttRef.current = rttMs;
      controllerRef.current?.setRttMs(rttMs);
      const next = nextAutoActive(autoRef.current, rttMs);
      if (next === autoRef.current) return;
      autoRef.current = next;
      setAutoActive(next);
    });
  }, [controllerRef, eligible, rttRef, runtime]);
  return autoActive;
}

/**
 * 每 pane 的预测回显：mode=off 或 editor 模式时不订阅任何信号、不加载引擎；
 * auto 按本 node 链路 RTT 滞回开关（≥50 ms 开，<30 ms 关）。
 */
function usePredictiveEcho(
  instance: CompatibleTerminalLike | null,
  inputMode: TerminalProps['inputMode']
): ControllerRef {
  const runtime = useRuntime();
  const mode: PredictiveEchoMode = useUIStore((state) => state.predictiveEcho);
  const host = instance?.prediction ?? null;
  const eligible = mode !== 'off' && inputMode === 'direct' && host !== null;
  const controllerRef = useRef<PredictiveEchoController | null>(null);
  const rttRef = useRef<number | null>(null);
  const autoActive = useLinkActivation(runtime, eligible, rttRef, controllerRef);
  const active = eligible && (mode === 'on' || autoActive);
  const textarea = instance?.textarea ?? null;

  useEffect(() => {
    if (!host || !active) return;
    return startController({ host, textarea, runtime, rttRef, controllerRef });
  }, [active, host, textarea, runtime]);

  return controllerRef;
}

/**
 * pane 输入出口：与 store 的 sendInput 同签名，发出后把字节交给预测回显。
 * 快照替换 / history 页 / rebase 都会 reset 终端，经 frame.generation 递增清空预测。
 */
export function usePredictiveSendInput(
  instance: CompatibleTerminalLike | null,
  inputMode: TerminalProps['inputMode'],
  deviceId: string,
  paneId: string
): SendInput {
  const runtime = useRuntime();
  const sendInput = useTmuxStore((state) => state.sendInput);
  const controllerRef = usePredictiveEcho(instance, inputMode);
  useEffect(
    () => registerPanePrediction(runtime, deviceId, paneId, controllerRef),
    [controllerRef, deviceId, paneId, runtime]
  );
  return useCallback<SendInput>(
    (targetDeviceId, targetPaneId, data, isComposing) => {
      sendInput(targetDeviceId, targetPaneId, data, isComposing);
      controllerRef.current?.noteInput(data, instance ? pastingInstances.has(instance) : false);
    },
    [controllerRef, instance, sendInput]
  );
}
