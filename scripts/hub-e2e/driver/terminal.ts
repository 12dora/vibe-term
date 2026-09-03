#!/usr/bin/env bun
import * as wsBorsh from '../../../packages/shared/src/ws-borsh/index.ts';
import { joinUrl, loadLoginState, parseArgs, requireArg, sleep } from './lib.ts';
import { analyzeSeqSources } from './seq.ts';

function generateSelectToken(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

function buildDeviceConnect(deviceId: string): { kind: number; payload: Uint8Array } {
  return {
    kind: wsBorsh.KIND_DEVICE_CONNECT,
    payload: wsBorsh.encodePayload(wsBorsh.schema.DeviceConnectSchema, { deviceId }),
  };
}

function buildTmuxSelect(params: {
  deviceId: string;
  windowId: string;
  paneId: string;
  selectToken: Uint8Array;
  wantHistory: boolean;
  cols: number;
  rows: number;
}): { kind: number; payload: Uint8Array } {
  return {
    kind: wsBorsh.KIND_TMUX_SELECT,
    payload: wsBorsh.encodePayload(wsBorsh.schema.TmuxSelectSchema, {
      deviceId: params.deviceId,
      windowId: params.windowId,
      paneId: params.paneId,
      selectToken: params.selectToken,
      wantHistory: params.wantHistory,
      cols: params.cols,
      rows: params.rows,
    }),
  };
}

function buildTermInput(
  deviceId: string,
  paneId: string,
  data: string
): { kind: number; payload: Uint8Array } {
  return {
    kind: wsBorsh.KIND_TERM_INPUT,
    payload: wsBorsh.encodePayload(wsBorsh.schema.TermInputSchema, {
      deviceId,
      paneId,
      encoding: 2,
      data: new TextEncoder().encode(data),
      isComposing: false,
    }),
  };
}

const args = parseArgs(process.argv.slice(2));
const baseUrl = requireArg(args, 'base-url');
const cookies = (await loadLoginState(requireArg(args, 'cookie-file'))).cookieHeader;
const nodeId = requireArg(args, 'node-id');
const deviceId = requireArg(args, 'device-id');
const paneId = typeof args['pane-id'] === 'string' ? args['pane-id'] : '';
const captureSeq = args['capture-seq'] === true || args['capture-seq'] === 'true';
const marker = typeof args.marker === 'string' ? args.marker : '';
if (!captureSeq && !marker) {
  throw new Error('missing --marker (or pass --capture-seq)');
}
const expectCount = Number(args['expect-count'] ?? 0);
const seqPrefix = typeof args['seq-prefix'] === 'string' ? args['seq-prefix'] : 'SEQ_';
const timeoutMs = Number(args.timeout ?? (captureSeq ? 90_000 : 20_000));
const readyFile = typeof args['ready-file'] === 'string' ? args['ready-file'] : '';
if (captureSeq && (!Number.isInteger(expectCount) || expectCount <= 0)) {
  throw new Error('missing --expect-count (positive integer)');
}

async function resolveInputCommand(): Promise<string> {
  if (typeof args['input-file'] === 'string') {
    return (await Bun.file(args['input-file']).text()).replace(/\s+$/, '');
  }
  if (typeof args.input === 'string') return args.input;
  return '';
}

const cid = crypto.randomUUID();
const wsUrl = joinUrl(baseUrl, `/n/${nodeId}/ws?cid=${cid}`).replace(/^http/, 'ws');

const ws = new WebSocket(wsUrl, {
  headers: {
    cookie: cookies,
    origin: baseUrl,
  },
});
ws.binaryType = 'arraybuffer';

let seq = 1;
const historyChunks: string[] = [];
const outputChunks: string[] = [];
let opened = false;
let helloOk = false;
let connected = false;
let snapshotPane: string | null = null;
let snapshotWindow: string | null = null;
let paneServerEpoch: Uint8Array | null = null;
let subscriptionGeneration = 0n;
let maxScreenBytes = 64 * 1024;
const screenBuffers = new Map<string, Uint8Array>();

function send(kind: number, payload: Uint8Array): void {
  const frame = wsBorsh.encodeEnvelope(kind, payload, seq);
  seq += 1;
  ws.send(frame);
}

function newRequestId(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

function sendCanonical(command: wsBorsh.CanonicalCommand): void {
  send(wsBorsh.KIND_CANONICAL_COMMAND, wsBorsh.encodeCanonicalCommandPayload(command));
}

/** 幂等全量订阅声明：generation 单调递增，网关按最新一代裁剪。 */
function sendSubscriptions(panes: wsBorsh.CanonicalPaneSubscription[]): void {
  subscriptionGeneration += 1n;
  sendCanonical({
    SetPaneSubscriptions: {
      generation: subscriptionGeneration,
      activePanes: panes,
      hotPanes: [],
    },
  });
}

function paneTarget(): wsBorsh.CanonicalPaneTarget | null {
  if (!snapshotPane || !paneServerEpoch) return null;
  return { deviceId, serverEpoch: paneServerEpoch, paneId: snapshotPane };
}

/** canonical 首屏事务：ScreenBegin 给总长，ScreenChunk 按 offset 填，ScreenCommit 收口。 */
function handleScreenEvent(event: wsBorsh.CanonicalEvent): void {
  if ('ScreenBegin' in event) {
    const begin = event.ScreenBegin;
    screenBuffers.set(bytesKey(begin.requestId), new Uint8Array(begin.totalBytes));
    return;
  }
  if ('ScreenChunk' in event) {
    const chunk = event.ScreenChunk;
    const buffer = screenBuffers.get(bytesKey(chunk.requestId));
    if (buffer && chunk.offset + chunk.data.byteLength <= buffer.byteLength) {
      buffer.set(chunk.data, chunk.offset);
    }
    return;
  }
  if ('ScreenCommit' in event) {
    const key = bytesKey(event.ScreenCommit.requestId);
    const buffer = screenBuffers.get(key);
    screenBuffers.delete(key);
    if (buffer) historyChunks.push(decodeText(buffer));
  }
}

function handleCanonicalEvent(payload: Uint8Array): void {
  let event: wsBorsh.CanonicalEvent;
  try {
    event = wsBorsh.decodeCanonicalEventPayload(payload).event;
  } catch (err) {
    process.stderr.write(`canonical decode failed: ${String(err)}\n`);
    return;
  }
  if ('FeedReady' in event) {
    maxScreenBytes = event.FeedReady.maxScreenBytes;
    return;
  }
  if ('SourceMetadataSnapshot' in event) {
    applyMetadataRecords(event.SourceMetadataSnapshot.records);
    return;
  }
  if ('SourceMetadataPatch' in event) {
    applyMetadataRecords(event.SourceMetadataPatch.upserts);
    return;
  }
  if ('PaneData' in event) {
    outputChunks.push(decodeText(event.PaneData.data));
    return;
  }
  handleScreenEvent(event);
}

/** 从 metadata 记录里挑出第一个带 pane 的 window（tmux index 顺序即记录顺序）。 */
function applyMetadataRecords(records: readonly wsBorsh.SourceMetadataRecord[]): void {
  if (snapshotPane) return;
  const windowOrder: string[] = [];
  const panesByWindow = new Map<string, Array<{ paneId: string; serverEpoch: Uint8Array }>>();
  for (const record of records) {
    if (record.key.deviceId !== deviceId) continue;
    if (record.key.entityKind === wsBorsh.SOURCE_ENTITY_WINDOW) {
      windowOrder.push(record.key.nativeId);
      continue;
    }
    if (record.key.entityKind !== wsBorsh.SOURCE_ENTITY_PANE) continue;
    const windowId = record.parent?.nativeId;
    if (!windowId) continue;
    const group = panesByWindow.get(windowId) ?? [];
    group.push({ paneId: record.key.nativeId, serverEpoch: record.key.serverEpoch });
    panesByWindow.set(windowId, group);
  }
  for (const windowId of windowOrder) {
    const pane = panesByWindow.get(windowId)?.[0];
    if (!pane) continue;
    snapshotWindow = windowId;
    snapshotPane = pane.paneId;
    paneServerEpoch = pane.serverEpoch;
    process.stderr.write(`metadata window=${windowId} pane=${pane.paneId}\n`);
    return;
  }
}

function bytesKey(bytes: Uint8Array): string {
  let key = '';
  for (const byte of bytes) key += byte.toString(16).padStart(2, '0');
  return key;
}

function decodeText(data: Uint8Array): string {
  try {
    return new TextDecoder().decode(data);
  } catch {
    return '';
  }
}

function capturedText(): string {
  return `${historyChunks.join('')}${outputChunks.join('')}`;
}

const openedAt = Date.now();
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('ws open timeout')), 10_000);
  ws.onopen = () => {
    opened = true;
    clearTimeout(timer);
    resolve();
  };
  ws.onerror = (ev) => {
    clearTimeout(timer);
    reject(new Error(`ws error: ${String((ev as { message?: string }).message ?? ev)}`));
  };
});

ws.onmessage = (ev) => {
  const data = ev.data as ArrayBuffer | Uint8Array | string | { buffer?: ArrayBufferLike };
  let raw: Uint8Array | null = null;
  if (data instanceof ArrayBuffer) raw = new Uint8Array(data);
  else if (data instanceof Uint8Array) raw = data;
  else if (typeof data !== 'string' && data && 'buffer' in data && data.buffer) {
    raw = new Uint8Array(data as Uint8Array);
  }
  if (!raw) {
    process.stderr.write(`ws non-binary message ${typeof ev.data}\n`);
    return;
  }
  let envelope: ReturnType<typeof wsBorsh.decodeEnvelope>;
  try {
    envelope = wsBorsh.decodeEnvelope(raw);
  } catch (err) {
    process.stderr.write(`ws decodeEnvelope failed len=${raw.byteLength}: ${String(err)}\n`);
    return;
  }
  process.stderr.write(`ws kind=0x${envelope.kind.toString(16)} seq=${envelope.seq}\n`);
  if (envelope.kind === wsBorsh.KIND_HELLO_S2C) {
    helloOk = true;
  }
  if (envelope.kind === wsBorsh.KIND_DEVICE_CONNECTED) {
    connected = true;
  }
  if (envelope.kind === wsBorsh.KIND_CANONICAL_EVENT) {
    handleCanonicalEvent(envelope.payload);
  }
};

const helloPayload = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
  clientImpl: 'tmex-e2e',
  // 网关的 canonical v1.1 版本门是 fail-closed 的，低于门槛直接被拒并关连接
  clientVersion: wsBorsh.CANONICAL_V11_MIN_PEER_VERSION,
  maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
  supportsCompression: false,
  supportsDiffSnapshot: false,
});
send(wsBorsh.KIND_HELLO_C2S, helloPayload);

const helloDeadline = Date.now() + 8_000;
while (!helloOk && Date.now() < helloDeadline) await sleep(50);
if (!helloOk) throw new Error('no HELLO_S2C');

// 先发一条空订阅打开 canonical 状态流（与前端一致），随后 DEVICE_CONNECT 才会推 metadata 快照
sendSubscriptions([]);

const connect = buildDeviceConnect(deviceId);
send(connect.kind, connect.payload);

const connectDeadline = Date.now() + 8_000;
while (!connected && Date.now() < connectDeadline) await sleep(50);

const snapDeadline = Date.now() + 8_000;
while (!snapshotPane && Date.now() < snapDeadline) await sleep(50);
const activePane = snapshotPane || paneId;
if (!activePane) {
  throw new Error('no pane in canonical metadata and no --pane-id fallback');
}
process.stderr.write(`using pane=${activePane} connected=${connected}\n`);

const target = paneTarget();
if (target) {
  sendSubscriptions([{ pane: target, cursor: null }]);
  // 首屏走 canonical 事务（取代 legacy TERM_HISTORY），落进 historyChunks 供 seq 归因
  sendCanonical({
    RequestScreen: { requestId: newRequestId(), pane: target, byteLimit: maxScreenBytes },
  });
}

if (snapshotWindow) {
  const select = buildTmuxSelect({
    deviceId,
    windowId: snapshotWindow,
    paneId: activePane,
    selectToken: generateSelectToken(),
    wantHistory: true,
    cols: 120,
    rows: 32,
  });
  send(select.kind, select.payload);
} else {
  process.stderr.write('no snapshot window; skipping TMUX_SELECT\n');
}
await sleep(800);

if (readyFile) {
  await Bun.write(
    readyFile,
    `${JSON.stringify({ ok: true, phase: 'subscribed', pane: activePane, connected })}\n`
  );
}

function sendPaste(text: string): void {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.TermPasteSchema, {
    deviceId,
    paneId: activePane,
    encoding: 2,
    data: new TextEncoder().encode(text.endsWith('\n') ? text : `${text}\n`),
    isComposing: false,
  });
  send(wsBorsh.KIND_TERM_PASTE, payload);
}

if (captureSeq) {
  const command = await resolveInputCommand();
  if (command) {
    sendPaste(command);
  }
  const deadline = Date.now() + timeoutMs;
  let result = analyzeSeqSources(
    historyChunks.join(''),
    outputChunks.join(''),
    expectCount,
    seqPrefix
  );
  while (Date.now() < deadline && !result.complete) {
    await sleep(100);
    result = analyzeSeqSources(
      historyChunks.join(''),
      outputChunks.join(''),
      expectCount,
      seqPrefix
    );
  }
  ws.close();
  const joined = capturedText();
  const body = {
    ok: result.complete,
    expectCount,
    seqPrefix,
    foundCount: result.found.length,
    fromHistory: result.fromHistory,
    fromOutput: result.fromOutput,
    first: result.found[0] ?? null,
    last: result.found[result.found.length - 1] ?? null,
    missing: result.missing.slice(0, 40),
    missingCount: result.missing.length,
    extra: result.extra.slice(0, 20),
    contiguous: result.contiguous,
    complete: result.complete,
    opened,
    helloOk,
    connected,
    elapsedMs: Date.now() - openedAt,
  };
  process.stdout.write(`${JSON.stringify(body)}\n`);
  if (!result.complete) {
    process.stderr.write(
      `seq capture incomplete missing=${result.missing.length} output=${JSON.stringify(joined.slice(-2000))}\n`
    );
    process.exit(1);
  }
  process.exit(0);
}

const input = buildTermInput(deviceId, activePane, `echo ${marker}\r`);
send(input.kind, input.payload);
await sleep(200);
sendPaste(`echo ${marker}`);

const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  const joined = capturedText();
  if (joined.includes(marker)) {
    ws.close();
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        marker,
        opened,
        helloOk,
        connected,
        elapsedMs: Date.now() - openedAt,
      })}\n`
    );
    process.exit(0);
  }
  await sleep(100);
}

ws.close();
process.stderr.write(
  `marker not observed: ${marker}\noutput=${JSON.stringify(capturedText().slice(-2000))}\n`
);
process.exit(1);
