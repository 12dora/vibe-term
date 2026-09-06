// 端口探测：输入停顿 500 ms 后各发一次。监听端口打 A 的 `/api/portmap/probe`，
// 目标端口打 B 的 `/api/portmap/target-probe`；失败一律当作「没探到」，不阻断表单。

import { createNodeApiClient, probeListenPort, probeTargetPort } from '@vibeterm/api-client';
import type { PortProbeResponse, TargetPortProbeResponse } from '@vibeterm/shared';
import { useEffect, useState } from 'react';

import { probeTarget } from './portmap-form-state';

export const PROBE_DEBOUNCE_MS = 500;

type Probe<T> = { value: T | null; probing: boolean };

function usePortProbe<T>(
  nodeId: string | null,
  host: string,
  port: string,
  enabled: boolean,
  run: (
    client: ReturnType<typeof createNodeApiClient>,
    host: string,
    port: number,
    signal: AbortSignal
  ) => Promise<T>
): Probe<T> {
  const [state, setState] = useState<Probe<T>>({ value: null, probing: false });
  const target = probeTarget(nodeId, host, port);
  const key = target ? `${target.nodeId}|${target.host}|${target.port}` : null;

  useEffect(() => {
    if (!enabled || key === null) {
      setState({ value: null, probing: false });
      return;
    }
    const [id, probeHost, probePort] = key.split('|');
    const controller = new AbortController();
    setState({ value: null, probing: true });
    const timer = setTimeout(() => {
      void run(createNodeApiClient(id), probeHost, Number(probePort), controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setState({ value, probing: false });
        })
        .catch(() => {
          if (!controller.signal.aborted) setState({ value: null, probing: false });
        });
    }, PROBE_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, key, run]);

  return state;
}

const runListenProbe = (
  client: ReturnType<typeof createNodeApiClient>,
  host: string,
  port: number,
  signal: AbortSignal
) => probeListenPort(client, host, port, signal);

const runTargetProbe = (
  client: ReturnType<typeof createNodeApiClient>,
  host: string,
  port: number,
  signal: AbortSignal
) => probeTargetPort(client, host, port, signal);

export function useListenPortProbe(
  nodeId: string | null,
  host: string,
  port: string,
  enabled = true
): Probe<PortProbeResponse> {
  return usePortProbe(nodeId, host, port, enabled, runListenProbe);
}

export function useTargetPortProbe(
  nodeId: string | null,
  host: string,
  port: string,
  enabled = true
): Probe<TargetPortProbeResponse> {
  return usePortProbe(nodeId, host, port, enabled, runTargetProbe);
}
