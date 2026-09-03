import type { KeyLogRecord } from './encoding';
import { decodeAdmitHubPayload, decodeRetireHubPayload, nodeIdToHex } from './encoding';
import type { ApplyKeyLogResult, UserKeyState } from './key-log';

export function applyAdmitHub(state: UserKeyState, record: KeyLogRecord): ApplyKeyLogResult {
  let payload: ReturnType<typeof decodeAdmitHubPayload>;
  try {
    payload = decodeAdmitHubPayload(record.payload);
  } catch {
    return { ok: false, error: 'malformed_payload' };
  }
  const hex = nodeIdToHex(payload.hub_node_id);
  const cert = state.nodeCerts.get(hex);
  if (!cert || cert.revoked) {
    return { ok: false, error: 'unknown_node' };
  }
  const existing = state.hubAuthorizations.get(hex);
  state.hubAuthorizations.set(hex, {
    status: 'active',
    publicUrl: payload.public_url ?? existing?.publicUrl ?? null,
    priority: payload.priority ?? existing?.priority ?? null,
    seq: record.seq,
  });
  return { ok: true, state, effects: [] };
}

export function applyRetireHub(state: UserKeyState, record: KeyLogRecord): ApplyKeyLogResult {
  let payload: ReturnType<typeof decodeRetireHubPayload>;
  try {
    payload = decodeRetireHubPayload(record.payload);
  } catch {
    return { ok: false, error: 'malformed_payload' };
  }
  const hex = nodeIdToHex(payload.hub_node_id);
  const existing = state.hubAuthorizations.get(hex);
  if (!existing) {
    return { ok: false, error: 'unknown_node' };
  }
  state.hubAuthorizations.set(hex, { ...existing, status: 'retired', seq: record.seq });
  return { ok: true, state, effects: [] };
}

export function retireHubIfAdmitted(state: UserKeyState, hex: string, seq: bigint): void {
  const existing = state.hubAuthorizations.get(hex);
  if (!existing) return;
  state.hubAuthorizations.set(hex, { ...existing, status: 'retired', seq });
}
