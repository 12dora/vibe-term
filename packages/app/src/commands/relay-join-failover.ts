import { RelayCaError } from '../lib/relay-ca';
import { JoinError } from './join-error';
import { RelayApiError } from './relay-shared';

export const RELAY_ENROLLMENT_LOOKUP_MISSING =
  'this relay does not expose GET /api/relay/tenants/:tenantId/enrollments/:enrollPk; upgrade the relay to 1.1.23 or newer';

/** 只有传输层失败才换下一个中继：中继明确拒绝（4xx/5xx 契约错误）换一台也是同样的答案。 */
function isRelayTransportError(error: unknown): boolean {
  if (error instanceof RelayCaError) return error.transport;
  return !(error instanceof RelayApiError) && !(error instanceof JoinError);
}

/** 这台中继没有这条 enrollment：fan-out 部分失败时 r3 里可能仍带着它，换下一台。CA 指纹不符仍直接失败。 */
function isMissingEnrollmentError(error: unknown): boolean {
  if (error instanceof RelayApiError) {
    return error.code === 'RELAY_ENROLLMENT_UNKNOWN' || error.code === 'RELAY_NOT_FOUND';
  }
  return error instanceof JoinError && error.message === RELAY_ENROLLMENT_LOOKUP_MISSING;
}

export function shouldTryNextRelay(error: unknown): boolean {
  return isRelayTransportError(error) || isMissingEnrollmentError(error);
}

/** 没有契约错误体的 404（代理页、缺这条路由的老中继）：与「中继明确说没有这条 enrollment」区分开。 */
export function isBareNotFound(error: unknown): boolean {
  return error instanceof RelayApiError && error.status === 404 && error.code === 'HTTP_404';
}
