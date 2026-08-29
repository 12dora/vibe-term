import { describe, expect, test } from 'bun:test';
import { broadcastThrottledEvent } from './throttled-event-broadcast';

describe('broadcastThrottledEvent', () => {
  test('sends only to clients that pass the throttle predicate and records attempts', () => {
    const clients = ['a', 'b', 'c'];
    const payload = new Uint8Array([1, 2]);
    const sent: Array<{ client: string; payload: Uint8Array }> = [];
    let recorded: number | undefined;

    broadcastThrottledEvent(
      clients,
      payload,
      (client) => client !== 'b',
      (client, bytes) => {
        sent.push({ client, payload: bytes });
      },
      (attempts) => {
        recorded = attempts;
      }
    );

    expect(sent).toEqual([
      { client: 'a', payload },
      { client: 'c', payload },
    ]);
    expect(recorded).toBe(2);
  });

  test('records zero attempts when every client is throttled', () => {
    const payload = new Uint8Array([9]);
    const sent: string[] = [];
    let recorded = -1;

    broadcastThrottledEvent(
      ['x', 'y'],
      payload,
      () => false,
      (client) => {
        sent.push(client);
      },
      (attempts) => {
        recorded = attempts;
      }
    );

    expect(sent).toEqual([]);
    expect(recorded).toBe(0);
  });
});
