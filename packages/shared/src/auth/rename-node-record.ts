import type { KeyLogRecord } from './encoding';
import { decodeRenameNodePayload, nodeIdToHex, normalizeNodeName } from './encoding';
import type { ApplyKeyLogResult, UserKeyState } from './key-log';

export function applyRenameNode(state: UserKeyState, record: KeyLogRecord): ApplyKeyLogResult {
  let payload: ReturnType<typeof decodeRenameNodePayload>;
  try {
    payload = decodeRenameNodePayload(record.payload);
  } catch {
    return { ok: false, error: 'malformed_payload' };
  }
  const name = normalizeNodeName(payload.name);
  if (!name) {
    return { ok: false, error: 'malformed_payload' };
  }
  const hex = nodeIdToHex(payload.node_id);
  const cert = state.nodeCerts.get(hex);
  if (!cert) {
    return { ok: false, error: 'unknown_node' };
  }
  state.nodeNames ??= new Map();
  state.nodeNames.set(hex, name);
  return { ok: true, state, effects: [] };
}
