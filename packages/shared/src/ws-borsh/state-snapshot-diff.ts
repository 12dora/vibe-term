import type { b } from '@zorsh/zorsh';
import type { StateSnapshotPayload } from '../index';
import {
  SOURCE_ENTITY_PANE,
  SOURCE_ENTITY_SESSION,
  SOURCE_ENTITY_WINDOW,
  SOURCE_FIELD_PANE_EPOCH,
  type SourceMetadataPatchSchema,
} from './canonical-state';
import type { LegacyMetadataFieldValue } from './legacy-pane-fields';
import { LegacySnapshotDraft } from './legacy-snapshot-draft';

export const STATE_SNAPSHOT_DIFF_FORMAT_ABSOLUTE_JSON = 1;
const MAX_DIFF_ENTITIES = 4_096;
const MAX_DIFF_FIELDS = 64;

export type { LegacyMetadataFieldValue } from './legacy-pane-fields';

export interface LegacyMetadataEntityDiff {
  entityKind: number;
  nativeId: string;
  parentKind: number | null;
  parentId: string | null;
  fields: Array<[number, LegacyMetadataFieldValue]>;
}

export interface LegacyStateSnapshotDiff {
  upserts: LegacyMetadataEntityDiff[];
  removals: Array<{ entityKind: number; nativeId: string }>;
}

type SourceMetadataPatch = b.infer<typeof SourceMetadataPatchSchema>;

function wireValue(value: SourceMetadataPatch['upserts'][number]['fields'][number]['value']) {
  if ('String' in value) return value.String;
  if ('Bool' in value) return value.Bool;
  if ('U16' in value) return value.U16;
  if ('U32' in value) return value.U32;
  if ('Unset' in value) return null;
  return undefined;
}

export function sourceMetadataPatchToLegacyDiff(
  patch: SourceMetadataPatch
): LegacyStateSnapshotDiff {
  const upserts: LegacyMetadataEntityDiff[] = [];
  for (const record of patch.upserts) {
    if (
      record.key.entityKind !== SOURCE_ENTITY_SESSION &&
      record.key.entityKind !== SOURCE_ENTITY_WINDOW &&
      record.key.entityKind !== SOURCE_ENTITY_PANE
    ) {
      continue;
    }
    const fields: Array<[number, LegacyMetadataFieldValue]> = [];
    for (const field of record.fields) {
      if (field.field === SOURCE_FIELD_PANE_EPOCH) continue;
      const value = wireValue(field.value);
      if (value !== undefined) fields.push([field.field, value]);
    }
    upserts.push({
      entityKind: record.key.entityKind,
      nativeId: record.key.nativeId,
      parentKind: record.parent?.entityKind ?? null,
      parentId: record.parent?.nativeId ?? null,
      fields,
    });
  }
  return {
    upserts,
    removals: patch.removals
      .filter(
        (key) =>
          key.entityKind === SOURCE_ENTITY_SESSION ||
          key.entityKind === SOURCE_ENTITY_WINDOW ||
          key.entityKind === SOURCE_ENTITY_PANE
      )
      .map((key) => ({ entityKind: key.entityKind, nativeId: key.nativeId })),
  };
}

export function encodeLegacyStateSnapshotDiff(diff: LegacyStateSnapshotDiff): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(diff));
}

export function decodeLegacyStateSnapshotDiff(data: Uint8Array): LegacyStateSnapshotDiff {
  const decoded = JSON.parse(new TextDecoder().decode(data)) as Partial<LegacyStateSnapshotDiff>;
  if (!Array.isArray(decoded.upserts) || !Array.isArray(decoded.removals)) {
    throw new Error('invalid state snapshot diff');
  }
  if (decoded.upserts.length > MAX_DIFF_ENTITIES || decoded.removals.length > MAX_DIFF_ENTITIES) {
    throw new Error('state snapshot diff entity limit exceeded');
  }
  for (const upsert of decoded.upserts) {
    if (
      !upsert ||
      typeof upsert.nativeId !== 'string' ||
      typeof upsert.entityKind !== 'number' ||
      !Array.isArray(upsert.fields) ||
      upsert.fields.length > MAX_DIFF_FIELDS
    ) {
      throw new Error('invalid state snapshot upsert');
    }
  }
  for (const removal of decoded.removals) {
    if (
      !removal ||
      typeof removal.nativeId !== 'string' ||
      typeof removal.entityKind !== 'number'
    ) {
      throw new Error('invalid state snapshot removal');
    }
  }
  return decoded as LegacyStateSnapshotDiff;
}

function applyRemoval(
  draft: LegacySnapshotDraft,
  removal: LegacyStateSnapshotDiff['removals'][number]
): void {
  if (removal.entityKind === SOURCE_ENTITY_SESSION) draft.removeSession(removal.nativeId);
  else if (removal.entityKind === SOURCE_ENTITY_WINDOW) draft.removeWindow(removal.nativeId);
  else if (removal.entityKind === SOURCE_ENTITY_PANE) draft.removePane(removal.nativeId);
}

function applyUpsert(draft: LegacySnapshotDraft, upsert: LegacyMetadataEntityDiff): void {
  if (upsert.entityKind === SOURCE_ENTITY_SESSION) {
    draft.upsertSession(upsert.nativeId, upsert.fields);
  } else if (upsert.entityKind === SOURCE_ENTITY_WINDOW) {
    draft.upsertWindow(upsert.nativeId, upsert.fields);
  } else if (upsert.entityKind === SOURCE_ENTITY_PANE && upsert.parentId) {
    draft.upsertPane(upsert.nativeId, upsert.parentId, upsert.fields);
  }
}

export function applyLegacyStateSnapshotDiff(
  snapshot: StateSnapshotPayload,
  diff: LegacyStateSnapshotDiff
): StateSnapshotPayload {
  const draft = new LegacySnapshotDraft(snapshot.session);
  for (const removal of diff.removals) applyRemoval(draft, removal);
  for (const upsert of diff.upserts) applyUpsert(draft, upsert);
  return { deviceId: snapshot.deviceId, session: draft.toSession() };
}
