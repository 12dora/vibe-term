import { afterEach, describe, expect, test } from 'bun:test';
import { notifyNodeOffline, registerNodeOfflineListener } from './node-offline-bus';

describe('node-offline-bus', () => {
  afterEach(() => {
    registerNodeOfflineListener(null);
  });

  test('notifies the registered listener', () => {
    const seen: string[] = [];
    registerNodeOfflineListener((nodeId) => {
      seen.push(nodeId);
    });
    notifyNodeOffline('peer-a');
    expect(seen).toEqual(['peer-a']);
  });
});
