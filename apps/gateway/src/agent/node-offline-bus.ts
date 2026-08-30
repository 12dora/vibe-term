type NodeOfflineListener = (nodeId: string) => void;

let listener: NodeOfflineListener | null = null;

export function registerNodeOfflineListener(fn: NodeOfflineListener | null): void {
  listener = fn;
}

export function notifyNodeOffline(nodeId: string): void {
  listener?.(nodeId);
}
