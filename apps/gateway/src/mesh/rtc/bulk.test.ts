import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FilesBulkHooks } from '../../api/files';
import { BULK_FRAME_SIZE, BULK_IDLE_TIMEOUT_MS, BulkTransferService } from './bulk';
import { DC_HIGH_WATER_BYTES } from './data-channel-carrier';
import { type FakeDataChannel, pairDataChannels } from './test-fakes';

type UploadRec = {
  uid: string;
  tempPath: string;
  expectedSize: number;
  received: number;
  dir: string;
};

type DownloadRec = {
  uid: string;
  tempPath: string;
  expectedSize: number;
  dir: string;
  streamOpened: boolean;
};

function concatSent(dc: FakeDataChannel): Uint8Array {
  const total = dc.sent.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const chunk of dc.sent) {
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  return out;
}

function parseJson(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (value && typeof value === 'object') return value as Record<string, unknown>;
  } catch {
    // not json
  }
  return null;
}

function jsonFromSent(dc: FakeDataChannel): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const chunk of dc.sent) {
    const parsed = parseJson(chunk);
    if (parsed) out.push(parsed);
  }
  return out;
}

async function waitFor(pred: () => boolean, label: string, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

function createHarness() {
  const uploads = new Map<string, UploadRec>();
  const downloads = new Map<string, DownloadRec>();
  const aborted: string[] = [];
  const dirs: string[] = [];

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'tmex-bulk-'));
    dirs.push(dir);
    return dir;
  }

  const hooks: FilesBulkHooks = {
    getTransferOwner(transferId) {
      const up = uploads.get(transferId);
      if (up) {
        return {
          uid: up.uid,
          tempPath: up.tempPath,
          expectedSize: up.expectedSize,
          kind: 'upload',
        };
      }
      const down = downloads.get(transferId);
      if (down) {
        return {
          uid: down.uid,
          tempPath: down.tempPath,
          expectedSize: down.expectedSize,
          kind: 'download',
        };
      }
      return null;
    },
    openDownload(transferId) {
      const down = downloads.get(transferId);
      if (!down) return null;
      down.streamOpened = true;
      let reader: ReadableStreamDefaultReader<Uint8Array>;
      try {
        reader = Bun.file(down.tempPath).stream().getReader();
      } catch {
        return null;
      }
      const cleanup = () => {
        const rec = downloads.get(transferId);
        if (!rec) return;
        downloads.delete(transferId);
        aborted.push(transferId);
        try {
          rmSync(rec.dir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      };
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              cleanup();
              return;
            }
            controller.enqueue(value);
          } catch (err) {
            controller.error(err);
            cleanup();
          }
        },
        cancel() {
          void reader.cancel();
          cleanup();
        },
      });
    },
    async appendUpload(transferId, bytes) {
      const up = uploads.get(transferId);
      if (!up) return { ok: false, code: 'not_found' };
      if (up.received + bytes.byteLength > up.expectedSize) {
        return { ok: false, code: 'too_large' };
      }
      writeFileSync(up.tempPath, bytes, { flag: 'a' });
      up.received += bytes.byteLength;
      return { ok: true, received: up.received };
    },
    abortTransfer(transferId) {
      const up = uploads.get(transferId);
      if (up) {
        uploads.delete(transferId);
        aborted.push(transferId);
        try {
          rmSync(up.dir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
      const down = downloads.get(transferId);
      if (down) {
        downloads.delete(transferId);
        aborted.push(transferId);
        try {
          rmSync(down.dir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    },
  };

  return {
    hooks,
    uploads,
    downloads,
    aborted,
    addUpload(id: string, uid: string, size: number): UploadRec {
      const dir = makeDir();
      const tempPath = join(dir, 'f');
      writeFileSync(tempPath, new Uint8Array(0));
      const rec: UploadRec = { uid, tempPath, expectedSize: size, received: 0, dir };
      uploads.set(id, rec);
      return rec;
    },
    addDownload(id: string, uid: string, data: Uint8Array): DownloadRec {
      const dir = makeDir();
      const tempPath = join(dir, 'f');
      writeFileSync(tempPath, data);
      const rec: DownloadRec = {
        uid,
        tempPath,
        expectedSize: data.byteLength,
        dir,
        streamOpened: false,
      };
      downloads.set(id, rec);
      return rec;
    },
    cleanup() {
      for (const dir of dirs) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // already gone
        }
      }
    },
  };
}

const harnesses: Array<ReturnType<typeof createHarness>> = [];
const services: BulkTransferService[] = [];

function setup(label: string) {
  const harness = createHarness();
  harnesses.push(harness);
  const service = new BulkTransferService({ files: harness.hooks });
  services.push(service);
  const [browser, node] = pairDataChannels(label);
  return { harness, service, browser, node };
}

afterEach(() => {
  for (const svc of services) svc.close();
  services.length = 0;
  for (const h of harnesses) h.cleanup();
  harnesses.length = 0;
});

describe('BulkTransferService', () => {
  test('happy upload writes the temp file and replies {ok:true}', async () => {
    const id = 'tx-up-ok';
    const { harness, service, browser, node } = setup(`bulk:${id}`);
    const rec = harness.addUpload(id, 'user-1', 3);
    service.attachChannel(node, { uid: 'user-1' });

    browser.sendMessage(JSON.stringify({ op: 'put', transferId: id, size: 3 }));
    browser.sendMessageBinary(Buffer.from([9, 8, 7]));
    browser.sendMessage(JSON.stringify({ op: 'done' }));

    await waitFor(() => jsonFromSent(node).some((m) => m.ok === true), 'ok reply');
    expect(readFileSync(rec.tempPath)).toEqual(Buffer.from([9, 8, 7]));
    expect(rec.received).toBe(3);
    expect(existsSync(rec.tempPath)).toBe(true);
  });

  test('happy upload accepts a 64 KiB frame plus a tail', async () => {
    const id = 'tx-up-64k';
    const payload = new Uint8Array(BULK_FRAME_SIZE + 11).fill(4);
    payload[0] = 1;
    payload[payload.byteLength - 1] = 2;
    const { harness, service, browser, node } = setup(`bulk:${id}`);
    harness.addUpload(id, 'user-1', payload.byteLength);
    service.attachChannel(node, { uid: 'user-1' });

    browser.sendMessage(JSON.stringify({ op: 'put', transferId: id, size: payload.byteLength }));
    browser.sendMessageBinary(Buffer.from(payload.subarray(0, BULK_FRAME_SIZE)));
    browser.sendMessageBinary(Buffer.from(payload.subarray(BULK_FRAME_SIZE)));
    browser.sendMessage(JSON.stringify({ op: 'done' }));

    await waitFor(() => jsonFromSent(node).some((m) => m.ok === true), 'ok reply');
    const rec = harness.uploads.get(id);
    expect(rec?.received).toBe(payload.byteLength);
    expect(readFileSync(rec?.tempPath ?? '')).toEqual(Buffer.from(payload));
  });

  test('size mismatch on done replies {ok:false} and cleans the temp file', async () => {
    const id = 'tx-mismatch';
    const { harness, service, browser, node } = setup(`bulk:${id}`);
    const rec = harness.addUpload(id, 'user-1', 4);
    service.attachChannel(node, { uid: 'user-1' });

    browser.sendMessage(JSON.stringify({ op: 'put', transferId: id, size: 4 }));
    browser.sendMessageBinary(Buffer.from([1, 2]));
    browser.sendMessage(JSON.stringify({ op: 'done' }));

    await waitFor(() => jsonFromSent(node).some((m) => m.ok === false), 'mismatch reply');
    const reply = jsonFromSent(node).find((m) => m.ok === false);
    expect(reply?.code).toBe('invalid');
    expect(existsSync(rec.tempPath)).toBe(false);
    expect(harness.uploads.has(id)).toBe(false);
  });

  test('abort mid-way cleans the temp file', async () => {
    const id = 'tx-abort';
    const { harness, service, browser, node } = setup(`bulk:${id}`);
    const rec = harness.addUpload(id, 'user-1', 8);
    service.attachChannel(node, { uid: 'user-1' });

    browser.sendMessage(JSON.stringify({ op: 'put', transferId: id, size: 8 }));
    browser.sendMessageBinary(Buffer.from([1, 2, 3]));
    expect(existsSync(rec.tempPath)).toBe(true);
    browser.sendMessage(JSON.stringify({ op: 'abort' }));

    await waitFor(() => !existsSync(rec.tempPath), 'temp cleaned');
    expect(harness.uploads.has(id)).toBe(false);
    expect(harness.aborted).toContain(id);
  });

  test('channel close mid-upload cleans the temp file', async () => {
    const id = 'tx-close';
    const { harness, service, browser, node } = setup(`bulk:${id}`);
    const rec = harness.addUpload(id, 'user-1', 8);
    service.attachChannel(node, { uid: 'user-1' });

    browser.sendMessage(JSON.stringify({ op: 'put', transferId: id, size: 8 }));
    browser.sendMessageBinary(Buffer.from([1, 2, 3]));
    browser.close();

    await waitFor(() => !existsSync(rec.tempPath), 'temp cleaned on close');
    expect(harness.uploads.has(id)).toBe(false);
  });

  test('download streams 64 KiB frames then {op:eof}', async () => {
    const id = 'tx-dl';
    const payload = new Uint8Array(BULK_FRAME_SIZE + 5).fill(6);
    payload[0] = 11;
    payload[payload.byteLength - 1] = 12;
    const { harness, service, browser, node } = setup(`bulk:${id}`);
    harness.addDownload(id, 'user-1', payload);
    service.attachChannel(node, { uid: 'user-1' });

    browser.sendMessage(JSON.stringify({ op: 'get' }));

    await waitFor(() => jsonFromSent(node).some((m) => m.op === 'eof'), 'eof', 2000);
    const frames = node.sent.filter((c) => parseJson(c) === null);
    expect(frames).toHaveLength(2);
    expect(frames[0]?.byteLength).toBe(BULK_FRAME_SIZE);
    expect(frames[1]?.byteLength).toBe(5);
    const body = concatSent(node);
    expect(body.subarray(0, payload.byteLength)).toEqual(payload);
  });

  test('download backpressure pauses above 4 MiB and resumes on low watermark', async () => {
    const id = 'tx-bp';
    const payload = new Uint8Array(64).fill(9);
    const { harness, service, browser, node } = setup(`bulk:${id}`);
    harness.addDownload(id, 'user-1', payload);
    service.attachChannel(node, { uid: 'user-1' });

    node.buffered = DC_HIGH_WATER_BYTES + 1;
    browser.sendMessage(JSON.stringify({ op: 'get' }));
    await Bun.sleep(30);
    expect(node.sent).toHaveLength(0);

    node.buffered = 0;
    node.emitLow();

    await waitFor(() => jsonFromSent(node).some((m) => m.op === 'eof'), 'eof after drain');
    const frames = node.sent.filter((c) => parseJson(c) === null);
    expect(frames[0]).toEqual(payload);
  });

  test('wrong uid is rejected without cleaning the transfer', async () => {
    const id = 'tx-uid';
    const { harness, service, browser, node } = setup(`bulk:${id}`);
    const rec = harness.addUpload(id, 'owner', 4);
    service.attachChannel(node, { uid: 'intruder' });

    browser.sendMessage(JSON.stringify({ op: 'put', transferId: id, size: 4 }));

    await waitFor(() => jsonFromSent(node).some((m) => m.ok === false), 'uid reject');
    expect(jsonFromSent(node)[0]?.code).toBe('permission_denied');
    expect(existsSync(rec.tempPath)).toBe(true);
    expect(harness.uploads.has(id)).toBe(true);
  });

  test('unknown transfer is rejected', async () => {
    const { service, browser, node } = setup('bulk:missing');
    service.attachChannel(node, { uid: 'user-1' });
    browser.sendMessage(JSON.stringify({ op: 'put', transferId: 'missing', size: 1 }));

    await waitFor(() => jsonFromSent(node).some((m) => m.ok === false), 'not found');
    expect(jsonFromSent(node)[0]?.code).toBe('not_found');
  });

  test('oversize message is rejected', async () => {
    const id = 'tx-oversize';
    const { harness, service, browser, node } = setup(`bulk:${id}`);
    harness.addUpload(id, 'user-1', 100);
    node.maxSize = 16;
    browser.maxSize = 16;
    service.attachChannel(node, { uid: 'user-1' });

    browser.sendMessage(JSON.stringify({ op: 'put', transferId: id, size: 100 }));
    browser.sendMessageBinary(Buffer.from(new Uint8Array(32).fill(1)));

    await waitFor(
      () => jsonFromSent(node).some((m) => m.ok === false && m.code === 'too_large'),
      'oversize reject'
    );
    expect(harness.uploads.has(id)).toBe(false);
  });

  test('wrong uid on download is rejected without opening the stream', async () => {
    const id = 'tx-dl-uid';
    const { harness, service, browser, node } = setup(`bulk:${id}`);
    harness.addDownload(id, 'owner', new Uint8Array([1, 2, 3]));
    service.attachChannel(node, { uid: 'intruder' });

    browser.sendMessage(JSON.stringify({ op: 'get' }));
    await waitFor(() => jsonFromSent(node).some((m) => m.ok === false), 'uid reject');
    expect(jsonFromSent(node)[0]?.code).toBe('permission_denied');
    expect(harness.downloads.get(id)?.streamOpened).toBe(false);
  });

  test('idle timeout without data aborts an in-flight upload and cleans temp', async () => {
    const id = 'tx-idle';
    const harness = createHarness();
    harnesses.push(harness);
    const service = new BulkTransferService({
      files: harness.hooks,
      idleTimeoutMs: 25,
    });
    services.push(service);
    const [browser, node] = pairDataChannels(`bulk:${id}`);
    const rec = harness.addUpload(id, 'user-1', 8);
    service.attachChannel(node, { uid: 'user-1' });
    browser.sendMessage(JSON.stringify({ op: 'put', transferId: id, size: 8 }));
    browser.sendMessageBinary(Buffer.from([1]));

    await waitFor(() => !existsSync(rec.tempPath), 'idle abort', 500);
    expect(jsonFromSent(node).some((m) => m.ok === false && m.code === 'timeout')).toBe(true);
  });

  test('put size that disagrees with the init session is rejected', async () => {
    const id = 'tx-size-init';
    const { harness, service, browser, node } = setup(`bulk:${id}`);
    harness.addUpload(id, 'user-1', 4);
    service.attachChannel(node, { uid: 'user-1' });
    browser.sendMessage(JSON.stringify({ op: 'put', transferId: id, size: 8 }));
    await waitFor(() => jsonFromSent(node).some((m) => m.ok === false), 'size reject');
    expect(jsonFromSent(node)[0]?.code).toBe('invalid');
    expect(harness.uploads.has(id)).toBe(true);
  });

  test('label that is not bulk:* is ignored', () => {
    const { service, browser, node } = setup('sess');
    service.attachChannel(node, { uid: 'user-1' });
    browser.sendMessage(JSON.stringify({ op: 'put', transferId: 'x', size: 1 }));
    expect(node.sent).toHaveLength(0);
  });

  test('idleTimeoutMs defaults to 30s', () => {
    expect(BULK_IDLE_TIMEOUT_MS).toBe(30_000);
  });

  test('put awaits a slow appendUpload before accepting done', async () => {
    const id = 'tx-await-put';
    const harness = createHarness();
    harnesses.push(harness);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const orig = harness.hooks.appendUpload.bind(harness.hooks);
    harness.hooks.appendUpload = async (transferId, bytes) => {
      await held;
      return orig(transferId, bytes);
    };
    const service = new BulkTransferService({ files: harness.hooks });
    services.push(service);
    const [browser, node] = pairDataChannels(`bulk:${id}`);
    harness.addUpload(id, 'user-1', 3);
    service.attachChannel(node, { uid: 'user-1' });

    browser.sendMessage(JSON.stringify({ op: 'put', transferId: id, size: 3 }));
    browser.sendMessageBinary(Buffer.from([9, 8, 7]));
    browser.sendMessage(JSON.stringify({ op: 'done' }));
    await Bun.sleep(20);
    expect(jsonFromSent(node).some((m) => m.ok === true)).toBe(false);
    expect(harness.uploads.get(id)?.received).toBe(0);

    release();
    await waitFor(() => jsonFromSent(node).some((m) => m.ok === true), 'ok after append');
    expect(harness.uploads.get(id)?.received).toBe(3);
  });

  test('verify failure and abortByOwner abort the channel', async () => {
    const id = 'tx-verify';
    const { harness, service, browser, node } = setup(`bulk:${id}`);
    harness.addUpload(id, 'user-1', 3);
    let live = true;
    service.attachChannel(node, {
      uid: 'user-1',
      ownerKey: 'conn-1',
      verify: () => live,
    });
    live = false;
    browser.sendMessage(JSON.stringify({ op: 'put', transferId: id, size: 3 }));
    await waitFor(() => jsonFromSent(node).some((m) => m.ok === false), 'forbidden');
    expect(jsonFromSent(node).some((m) => m.code === 'forbidden')).toBe(true);

    const id2 = 'tx-abort-owner';
    const { harness: h2, service: s2, browser: b2, node: n2 } = setup(`bulk:${id2}`);
    h2.addUpload(id2, 'user-1', 3);
    s2.attachChannel(n2, { uid: 'user-1', ownerKey: 'conn-2' });
    b2.sendMessage(JSON.stringify({ op: 'put', transferId: id2, size: 3 }));
    b2.sendMessageBinary(Buffer.from([1]));
    s2.abortByOwner('conn-2');
    expect(h2.aborted).toContain(id2);
  });

  test('download verifies before every data frame and EOF and aborts on failure', async () => {
    const id = 'tx-dl-verify';
    const payload = new Uint8Array(BULK_FRAME_SIZE + 5).fill(7);
    const { harness, service, browser, node } = setup(`bulk:${id}`);
    harness.addDownload(id, 'user-1', payload);
    let calls = 0;
    service.attachChannel(node, {
      uid: 'user-1',
      verify: () => {
        calls += 1;
        return calls < 3;
      },
    });
    browser.sendMessage(JSON.stringify({ op: 'get' }));
    await waitFor(
      () => jsonFromSent(node).some((m) => m.ok === false && m.code === 'forbidden'),
      'download forbidden'
    );
    expect(jsonFromSent(node).some((m) => m.op === 'eof')).toBe(false);
    expect(harness.aborted).toContain(id);
  });
});
