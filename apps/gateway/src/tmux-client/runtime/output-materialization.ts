export type PaneOutputMaterializationPredicate = (paneId: string) => boolean;

export type PaneOutputMaterializationRequest = {
  data: Uint8Array;
  predicate: PaneOutputMaterializationPredicate | null;
};

const pendingRequests = new WeakMap<Uint8Array, PaneOutputMaterializationRequest>();

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
