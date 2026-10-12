import { RelayTransportError } from '../commands/relay-shared';
import { RelayCaError } from './relay-ca';

/** 「中继不可达」的唯一判据：请求没拿到响应（含超时、读体中断），或取 CA 时的传输失败。 */
export function isRelayUnreachable(error: unknown): boolean {
  if (error instanceof RelayTransportError) return true;
  return error instanceof RelayCaError && error.transport;
}
