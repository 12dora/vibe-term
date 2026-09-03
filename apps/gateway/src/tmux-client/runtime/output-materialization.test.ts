import { describe, expect, test } from 'bun:test';

import {
  clearLegacyPaneOutputObservers,
  finishPaneOutputMaterializationRequest,
  isLegacyPaneOutputObserved,
  markLegacyPaneOutputObserversTracked,
  providePaneOutputMaterializationPredicate,
  requestPaneOutputMaterializationPredicate,
  setLegacyPaneOutputObserved,
  setPaneOutputClientPresence,
  syncLegacyPaneOutputObserverCounts,
} from './output-materialization';

describe('pane output materialization wiring', () => {
  test('resolves a predicate through the output view identity', () => {
    const data = new Uint8Array([1]);
    const predicate = (paneId: string) => paneId === '%1';
    const request = requestPaneOutputMaterializationPredicate(data);
    providePaneOutputMaterializationPredicate(data, predicate);
    expect(finishPaneOutputMaterializationRequest(request)).toBe(predicate);
  });

  test('idle devices are unobserved and connected clients stay conservative until tracking starts', () => {
    const deviceId = 'device-observation';
    clearLegacyPaneOutputObservers(deviceId);
    expect(isLegacyPaneOutputObserved(deviceId, '%1')).toBe(false);

    setPaneOutputClientPresence(deviceId, true);
    expect(isLegacyPaneOutputObserved(deviceId, '%1')).toBe(true);
    markLegacyPaneOutputObserversTracked(deviceId);
    expect(isLegacyPaneOutputObserved(deviceId, '%1')).toBe(false);

    setLegacyPaneOutputObserved(deviceId, '%1', true);
    expect(isLegacyPaneOutputObserved(deviceId, '%1')).toBe(true);
    expect(isLegacyPaneOutputObserved(deviceId, '%2')).toBe(false);
    setLegacyPaneOutputObserved(deviceId, '%1', false);
    expect(isLegacyPaneOutputObserved(deviceId, '%1')).toBe(false);

    syncLegacyPaneOutputObserverCounts(
      deviceId,
      new Map([
        [`${deviceId}\0%2`, 2],
        ['other-device\0%1', 1],
      ])
    );
    expect(isLegacyPaneOutputObserved(deviceId, '%1')).toBe(false);
    expect(isLegacyPaneOutputObserved(deviceId, '%2')).toBe(true);

    setPaneOutputClientPresence(deviceId, false);
    clearLegacyPaneOutputObservers(deviceId);
  });
});
