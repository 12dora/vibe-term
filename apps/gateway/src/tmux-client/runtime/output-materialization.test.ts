import { describe, expect, test } from 'bun:test';

import {
  finishPaneOutputMaterializationRequest,
  providePaneOutputMaterializationPredicate,
  requestPaneOutputMaterializationPredicate,
} from './output-materialization';

describe('pane output materialization wiring', () => {
  test('resolves a predicate through the output view identity', () => {
    const data = new Uint8Array([1]);
    const predicate = (paneId: string) => paneId === '%1';
    const request = requestPaneOutputMaterializationPredicate(data);
    providePaneOutputMaterializationPredicate(data, predicate);
    expect(finishPaneOutputMaterializationRequest(request)).toBe(predicate);
  });

  test('第一个 provide 生效，后续 provide 不覆盖', () => {
    const data = new Uint8Array([2]);
    const first = () => true;
    const second = () => false;
    const request = requestPaneOutputMaterializationPredicate(data);
    providePaneOutputMaterializationPredicate(data, first);
    providePaneOutputMaterializationPredicate(data, second);
    expect(finishPaneOutputMaterializationRequest(request)).toBe(first);
  });

  test('未 provide 时返回 null，并清理挂起请求', () => {
    const data = new Uint8Array([3]);
    const request = requestPaneOutputMaterializationPredicate(data);
    expect(finishPaneOutputMaterializationRequest(request)).toBeNull();
    providePaneOutputMaterializationPredicate(data, () => true);
    expect(finishPaneOutputMaterializationRequest(request)).toBeNull();
  });
});
