import {
  HUB_ATTACHMENTS_FRAME_MAX_BYTES,
  type HubAttachmentsEntry,
  type HubAttachmentsMessage,
  UPLINK_CTL_MAX_ATTACHMENT_ENTRIES,
  UPLINK_CTL_MAX_BYTES,
  encodeHubUplinkCtl,
} from '@tmex/shared/uplink';

export { HUB_ATTACHMENTS_FRAME_MAX_BYTES, UPLINK_CTL_MAX_ATTACHMENT_ENTRIES };

const PENDING_SNAPSHOT_MAX = 8;

export function assertHubAttachmentsEncodedSize(msg: HubAttachmentsMessage): Uint8Array {
  const encoded = encodeHubUplinkCtl(msg);
  if (encoded.byteLength > HUB_ATTACHMENTS_FRAME_MAX_BYTES) {
    throw new Error(
      `hub.attachments frame ${encoded.byteLength} exceeds ${HUB_ATTACHMENTS_FRAME_MAX_BYTES} (hard ${UPLINK_CTL_MAX_BYTES})`
    );
  }
  return encoded;
}

function attachmentsFit(msg: HubAttachmentsMessage): boolean {
  if (msg.entries.length > UPLINK_CTL_MAX_ATTACHMENT_ENTRIES) return false;
  try {
    assertHubAttachmentsEncodedSize(msg);
    return true;
  } catch {
    return false;
  }
}

export function paginateHubAttachments(
  entries: HubAttachmentsEntry[],
  opts: { revision: number; snapshotId: string; full?: boolean }
): HubAttachmentsMessage[] {
  const pages: HubAttachmentsMessage[] = [];
  let batch: HubAttachmentsEntry[] = [];
  const frame = (
    tokens: HubAttachmentsEntry[],
    page: number,
    final: boolean
  ): HubAttachmentsMessage => ({
    t: 'hub.attachments',
    revision: opts.revision,
    entries: tokens,
    snapshotId: opts.snapshotId,
    page,
    final,
    ...(opts.full ? { full: true } : {}),
  });
  for (const row of entries) {
    const next = [...batch, row];
    if (batch.length > 0 && !attachmentsFit(frame(next, pages.length, false))) {
      pages.push(frame(batch, pages.length, false));
      batch = [row];
      if (!attachmentsFit(frame(batch, pages.length, false))) {
        batch = [];
      }
    } else if (batch.length === 0 && !attachmentsFit(frame(next, pages.length, false))) {
      console.warn(`[hub] hub.attachments skip oversized node=${row.nodeId}`);
    } else {
      batch = next;
    }
  }
  if (batch.length > 0 || pages.length === 0) {
    pages.push(frame(batch, pages.length, true));
  } else {
    const last = pages[pages.length - 1];
    if (last) last.final = true;
  }
  for (const page of pages) assertHubAttachmentsEncodedSize(page);
  return pages;
}

export class AttachmentSnapshotAssembler {
  private readonly pending = new Map<
    string,
    {
      fromHubId: string;
      revision: number;
      full?: boolean;
      pages: Map<number, HubAttachmentsEntry[]>;
    }
  >();

  push(fromHubId: string, msg: HubAttachmentsMessage): HubAttachmentsMessage | null {
    if (!msg.snapshotId) return msg;
    const key = `${fromHubId.trim().toLowerCase()}\0${msg.snapshotId}`;
    let row = this.pending.get(key);
    if (!row) {
      this.dropFrom(fromHubId);
      row = {
        fromHubId: fromHubId.trim().toLowerCase(),
        revision: msg.revision,
        full: msg.full,
        pages: new Map(),
      };
      this.pending.set(key, row);
      this.enforceCap();
    }
    row.pages.set(msg.page ?? 0, msg.entries);
    if (msg.full) row.full = true;
    if (msg.final !== true) return null;
    const lastPage = msg.page ?? 0;
    const entries: HubAttachmentsEntry[] = [];
    for (let i = 0; i <= lastPage; i++) {
      const page = row.pages.get(i);
      if (!page) return null;
      entries.push(...page);
    }
    this.pending.delete(key);
    return {
      t: 'hub.attachments',
      revision: row.revision,
      entries,
      ...(row.full ? { full: true } : {}),
      snapshotId: msg.snapshotId,
      page: 0,
      final: true,
    };
  }

  private dropFrom(fromHubId: string): void {
    const prefix = `${fromHubId.trim().toLowerCase()}\0`;
    for (const key of this.pending.keys()) {
      if (key.startsWith(prefix)) this.pending.delete(key);
    }
  }

  private enforceCap(): void {
    while (this.pending.size > PENDING_SNAPSHOT_MAX) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }
}
