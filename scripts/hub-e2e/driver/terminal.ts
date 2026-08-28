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
      windowId: null,
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
const paneId = requireArg(args, 'pane-id');
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

function send(kind: number, payload: Uint8Array): void {
  const frame = wsBorsh.encodeEnvelope(kind, payload, seq);
  seq += 1;
  ws.send(frame);
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
  if (envelope.kind === wsBorsh.KIND_STATE_SNAPSHOT) {
    try {
      const snap = wsBorsh.decodePayload(wsBorsh.schema.StateSnapshotSchema, envelope.payload) as {
        session?: { windows?: Array<{ panes?: Array<{ id: string }> }> } | null;
      };
      snapshotPane = snap.session?.windows?.[0]?.panes?.[0]?.id ?? null;
      process.stderr.write(`snapshot pane=${snapshotPane ?? 'null'}\n`);
    } catch (err) {
      process.stderr.write(`snapshot decode failed: ${String(err)}\n`);
    }
  }
  if (envelope.kind === wsBorsh.KIND_TERM_OUTPUT || envelope.kind === wsBorsh.KIND_TERM_HISTORY) {
    try {
      const isHistory = envelope.kind === wsBorsh.KIND_TERM_HISTORY;
      const schema = isHistory ? wsBorsh.schema.TermHistorySchema : wsBorsh.schema.TermOutputSchema;
      const payload = wsBorsh.decodePayload(schema, envelope.payload) as { data: Uint8Array };
      const text = decodeText(payload.data);
      if (isHistory) historyChunks.push(text);
      else outputChunks.push(text);
    } catch (err) {
      process.stderr.write(`term decode failed: ${String(err)}\n`);
    }
  }
};

const helloPayload = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
  clientImpl: 'tmex-e2e',
  clientVersion: '1.0.2',
  maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
  supportsCompression: false,
  supportsDiffSnapshot: false,
});
send(wsBorsh.KIND_HELLO_C2S, helloPayload);

const helloDeadline = Date.now() + 8_000;
while (!helloOk && Date.now() < helloDeadline) await sleep(50);
if (!helloOk) throw new Error('no HELLO_S2C');

const connect = buildDeviceConnect(deviceId);
send(connect.kind, connect.payload);

const connectDeadline = Date.now() + 8_000;
while (!connected && Date.now() < connectDeadline) await sleep(50);

const snapDeadline = Date.now() + 8_000;
while (!snapshotPane && Date.now() < snapDeadline) await sleep(50);
const activePane = snapshotPane || paneId;
process.stderr.write(`using pane=${activePane} connected=${connected}\n`);

const sub = wsBorsh.encodePayload(wsBorsh.schema.TmuxSubscribePanesSchema, {
  deviceId,
  paneIds: [activePane],
});
send(wsBorsh.KIND_TMUX_SUBSCRIBE_PANES, sub);

const select = buildTmuxSelect({
  deviceId,
  paneId: activePane,
  selectToken: generateSelectToken(),
  wantHistory: true,
  cols: 120,
  rows: 32,
});
send(select.kind, select.payload);
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
