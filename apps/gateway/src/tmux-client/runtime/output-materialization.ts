export type PaneOutputMaterializationPredicate = (paneId: string) => boolean;

export type PaneOutputMaterializationRequest = {
  data: Uint8Array;
  predicate: PaneOutputMaterializationPredicate | null;
};

const pendingRequests = new WeakMap<Uint8Array, PaneOutputMaterializationRequest>();

type LegacyObservationState = {
  hasClients: boolean;
  tracked: boolean;
  panes: Set<string>;
};

const legacyObservationStates = new Map<string, LegacyObservationState>();

function getLegacyObservationState(deviceId: string): LegacyObservationState {
  const existing = legacyObservationStates.get(deviceId);
  if (existing) return existing;
  const state = { hasClients: false, tracked: false, panes: new Set<string>() };
  legacyObservationStates.set(deviceId, state);
  return state;
}

export function requestPaneOutputMaterializationPredicate(
  data: Uint8Array
): PaneOutputMaterializationRequest {
  // 外层连接会包装 output callback；用首个真实输出的对象身份完成一次能力发现，避免耦合连接实现。
  const request: PaneOutputMaterializationRequest = { data, predicate: null };
  pendingRequests.set(data, request);
  return request;
}

export function providePaneOutputMaterializationPredicate(
  data: Uint8Array,
  predicate: PaneOutputMaterializationPredicate
): void {
  const request = pendingRequests.get(data);
  if (request && !request.predicate) request.predicate = predicate;
}

export function finishPaneOutputMaterializationRequest(
  request: PaneOutputMaterializationRequest
): PaneOutputMaterializationPredicate | null {
  pendingRequests.delete(request.data);
  return request.predicate;
}

export function setLegacyPaneOutputObserved(
  deviceId: string,
  paneId: string,
  observed: boolean
): void {
  const state = getLegacyObservationState(deviceId);
  state.tracked = true;
  if (observed) {
    state.panes.add(paneId);
    return;
  }
  state.panes.delete(paneId);
}

export function markLegacyPaneOutputObserversTracked(deviceId: string): void {
  getLegacyObservationState(deviceId).tracked = true;
}

export function syncLegacyPaneOutputObserverCounts(
  deviceId: string,
  observerCounts: ReadonlyMap<string, number>
): void {
  const state = getLegacyObservationState(deviceId);
  const prefix = `${deviceId}\0`;
  state.tracked = true;
  state.panes.clear();
  for (const [key, count] of observerCounts) {
    if (count > 0 && key.startsWith(prefix)) state.panes.add(key.slice(prefix.length));
  }
}

export function setPaneOutputClientPresence(deviceId: string, hasClients: boolean): void {
  const state = getLegacyObservationState(deviceId);
  state.hasClients = hasClients;
  if (!hasClients && state.panes.size === 0) legacyObservationStates.delete(deviceId);
}

export function isLegacyPaneOutputObserved(deviceId: string, paneId: string): boolean {
  const state = legacyObservationStates.get(deviceId);
  if (!state?.hasClients) return false;
  // 观察者计数接线生效前对已连接客户端保持旧行为，避免 legacy feed 丢输出。
  return state.tracked ? state.panes.has(paneId) : true;
}

export function clearLegacyPaneOutputObservers(deviceId: string): void {
  legacyObservationStates.delete(deviceId);
}
