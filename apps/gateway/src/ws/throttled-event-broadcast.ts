export function broadcastThrottledEvent<TClient>(
  clients: Iterable<TClient>,
  payload: Uint8Array,
  shouldDeliver: (client: TClient) => boolean,
  send: (client: TClient, payload: Uint8Array) => void,
  record: (deliveryAttempts: number) => void
): void {
  let deliveryAttempts = 0;
  for (const client of clients) {
    if (!shouldDeliver(client)) {
      continue;
    }
    send(client, payload);
    deliveryAttempts += 1;
  }
  record(deliveryAttempts);
}
