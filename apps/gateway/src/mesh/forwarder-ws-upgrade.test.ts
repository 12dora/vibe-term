import { describe, expect, test } from 'bun:test';
import {
  FORWARD_WS_LINK_FAILURE_REASON,
  FORWARD_WS_LINK_TIMEOUT_REASON,
  forwardWsLinkFailureReason,
} from './forwarder-ws-upgrade';

describe('forwardWsLinkFailureReason', () => {
  test('timeout / abort / generic getLink failure stay distinct from 4401 reasons', () => {
    expect(forwardWsLinkFailureReason(new Error('forward-link-timeout'))).toBe(
      FORWARD_WS_LINK_TIMEOUT_REASON
    );
    expect(
      forwardWsLinkFailureReason(new DOMException('The operation was aborted.', 'AbortError'))
    ).toBe('aborted');
    expect(forwardWsLinkFailureReason(new Error('offline'))).toBe(FORWARD_WS_LINK_FAILURE_REASON);
    expect(forwardWsLinkFailureReason('nope')).toBe(FORWARD_WS_LINK_FAILURE_REASON);
    expect(FORWARD_WS_LINK_FAILURE_REASON).not.toBe('NODE_LOGIN_REQUIRED');
    expect(FORWARD_WS_LINK_TIMEOUT_REASON).not.toBe('NODE_LOGIN_REQUIRED');
  });
});
