import {
  type CtlReaders,
  KEY_LOG_PAGE_MAX_LIMIT,
  TYPE_SET,
  UPLINK_CTL_MAX_BYTES,
  UPLINK_CTL_MAX_CERT_BYTES,
  type UplinkCtlType,
  assertCtlBounds,
  decodeUtf8,
  isRecord,
  skipsCtlBounds,
  utf8ByteLength,
} from './codec-fields';
import {
  type HubAdvertisement,
  type HubAttachmentsMessage,
  type HubForwardMessage,
  type HubTokensMessage,
  type HubWriteForwardMessage,
  parseHubAdvertisement,
  parseHubAttachmentsMessage,
  parseHubForwardMessage,
  parseHubTokensMessage,
  parseHubWriteForwardMessage,
} from './codec-hub-frames';

export type HubFrameCtlType =
  | 'hub.tokens'
  | 'hub.attachments'
  | 'hub.forward'
  | 'hub.write-forward';
export type CoreCtlType = Exclude<UplinkCtlType, HubFrameCtlType>;
export type HubFrameCtlMessage =
  | HubTokensMessage
  | HubAttachmentsMessage
  | HubForwardMessage
  | HubWriteForwardMessage;

const HUB_FRAME_TYPES = new Set<string>([
  'hub.tokens',
  'hub.attachments',
  'hub.forward',
  'hub.write-forward',
]);

export function isHubFrameCtlType(t: UplinkCtlType): t is HubFrameCtlType {
  return HUB_FRAME_TYPES.has(t);
}

/** hub 线以 b64url 字符串 + number|string seq 承载，mesh 线以 Uint8Array + bigint 承载。 */
export type UplinkCtlDecoded<Bytes, Seq> =
  | { t: 'auth.challenge'; nonce: string }
  | { t: 'auth.response'; node_id: string; sig: string }
  | { t: 'auth.ok' }
  | { t: 'ping' }
  | { t: 'pong' }
  | {
      t: 'node.status';
      version: string;
      tmux: boolean;
      direct_capable: boolean;
      inventory: unknown;
      endpoints: unknown;
      hub?: HubAdvertisement;
    }
  | { t: 'key.log.req'; from_seq: Seq; id?: string; limit?: number }
  | {
      t: 'key.log.res';
      records: { seq: Seq; bytes: Bytes; sig: Bytes }[];
      id?: string;
      error?: string;
      has_more?: boolean;
      retry_after_ms?: number;
    }
  | { t: 'key.log.append'; bytes: Bytes; sig: Bytes; id?: string; force?: boolean }
  | { t: 'key.log.ack'; id: string; ok: boolean; seq?: Seq; error?: string }
  | {
      t: 'rtc.signal';
      rtcSession: string;
      from: 'browser' | 'node';
      to: string;
      sdp?: string;
      candidate?: string;
    }
  | HubFrameCtlMessage;

export type EnrollRedeemedFields<Bytes> = {
  certificate: Bytes;
  certSig: Bytes;
  enrollPk: Bytes;
  nodeId: string;
  entrySid?: string;
  alreadyAdmitted?: boolean;
};

/**
 * 两条线（hub / mesh）唯一的 ctl 解码实现，差异全部收敛到这份 profile：
 * 报错类型、字节/序号的线上表示、node.list 与 enroll.redeemed 的落地形状。
 */
export type CtlDecodeProfile<Bytes, Seq, NodeList, Enroll> = {
  readers: CtlReaders;
  fail(message: string): Error;
  /** 超过即直接判定过大；hub 线为 UPLINK_CTL_MAX_BYTES，mesh 线为 key log 分页上限。 */
  hardMaxBytes: number;
  onJsonError(err: unknown): Error;
  notObject: string;
  unknownType(t: string): Error;
  /** `t` 不是字符串时的报错：hub 线并入 unknown t，mesh 线视作「不是带 t 的对象」。 */
  notStringType(value: unknown): Error;
  bytes(value: unknown, field: string, expectedLen?: number, maxLen?: number): Bytes;
  /** b64url 字段但本线以字符串承载（auth.challenge / auth.response）。 */
  text(value: unknown, field: string, expectedLen?: number): string;
  nodeIdText(value: unknown, field: string): string;
  /** 可选字符串字段（id / error / entry_sid）：hub 线拒空串，mesh 线丢弃空串。 */
  optText(value: unknown, field: string): string | undefined;
  /** 必填字符串字段：hub 线要求非空，mesh 线原样接受。 */
  reqText(value: unknown, field: string): string;
  seq(value: unknown, field: string): Seq;
  inventory(value: unknown): unknown;
  endpoints(value: unknown): unknown;
  /** hub 线额外校验 key log 签名长度。 */
  keyLogSigLen?: number;
  /** key.log.res 记录的报错文案与字段标签两条线不同。 */
  keyLogRes: {
    notArray: string;
    notObject(index: number): string;
    field(index: number, name: 'seq' | 'bytes' | 'sig'): string;
  };
  rtcFrom(value: unknown): 'browser' | 'node';
  optSignalText(value: unknown, field: 'sdp' | 'candidate'): string | undefined;
  /** 只有 hub 线落地 enroll.redeemed 的 already_admitted。 */
  keepAlreadyAdmitted?: boolean;
  nodeList(parsed: Record<string, unknown>): NodeList;
  enrollRedeemed(fields: EnrollRedeemedFields<Bytes>): Enroll;
  frame<T>(fallback: string, fn: () => T): T;
};

type AnyProfile<B, S, NL, ER> = CtlDecodeProfile<B, S, NL, ER>;

export type DecodeUplinkCtlOptions = {
  /** hub 线默认拒收 key.log.res，只有主动发起过请求的连接才放行。 */
  allowKeyLogRes?: boolean;
  /** mesh 线放行超尺寸 key.log.res 的唯一凭据：请求 id 必须匹配。 */
  pendingKeyLogId?: string;
};

function checkCtlSize<B, S, NL, ER>(
  byteLength: number,
  profile: AnyProfile<B, S, NL, ER>,
  pendingKeyLogId?: string
): void {
  if (byteLength > profile.hardMaxBytes) throw profile.fail('ctl too large');
  if (byteLength > UPLINK_CTL_MAX_BYTES && !pendingKeyLogId) throw profile.fail('ctl too large');
}

function assertCtlPayloadBounds<B, S, NL, ER>(
  parsed: Record<string, unknown>,
  byteLength: number,
  profile: AnyProfile<B, S, NL, ER>,
  opts: DecodeUplinkCtlOptions | undefined
): void {
  if (parsed.t === 'key.log.res') {
    if (opts?.allowKeyLogRes !== true) throw profile.fail('unexpected key.log.res');
    if (byteLength > UPLINK_CTL_MAX_BYTES) {
      const resId = profile.readers.optStr(parsed.id, 'id');
      if (!resId || resId !== opts?.pendingKeyLogId) throw profile.fail('ctl too large');
      return;
    }
  }
  if (byteLength > UPLINK_CTL_MAX_BYTES) throw profile.fail('ctl too large');
  if (!skipsCtlBounds(parsed.t)) assertCtlBounds(parsed, 0);
}

function prepareCtl<B, S, NL, ER>(
  input: Uint8Array | string,
  profile: AnyProfile<B, S, NL, ER>,
  opts: DecodeUplinkCtlOptions | undefined
): Record<string, unknown> {
  const byteLength = typeof input === 'string' ? utf8ByteLength(input) : input.byteLength;
  checkCtlSize(byteLength, profile, opts?.pendingKeyLogId);
  const text = typeof input === 'string' ? input : decodeUtf8(input);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw profile.onJsonError(err);
  }
  if (!isRecord(parsed)) throw profile.fail(profile.notObject);
  const t = parsed.t;
  if (typeof t !== 'string') throw profile.notStringType(t);
  assertCtlPayloadBounds(parsed, byteLength, profile, opts);
  if (!TYPE_SET.has(t)) throw profile.unknownType(t);
  return parsed;
}

function decodeNodeStatus<B, S, NL, ER>(
  parsed: Record<string, unknown>,
  p: AnyProfile<B, S, NL, ER>
): UplinkCtlDecoded<B, S> {
  const status: Extract<UplinkCtlDecoded<B, S>, { t: 'node.status' }> = {
    t: 'node.status',
    version: p.readers.str(parsed.version, 'version'),
    tmux: p.readers.bool(parsed.tmux, 'tmux'),
    direct_capable: p.readers.bool(parsed.direct_capable, 'direct_capable'),
    inventory: p.inventory(parsed.inventory),
    endpoints: p.endpoints(parsed.endpoints),
  };
  if (parsed.hub !== undefined && parsed.hub !== null) {
    status.hub = parseHubAdvertisement(parsed.hub);
  }
  return status;
}

function decodeKeyLogReq<B, S, NL, ER>(
  parsed: Record<string, unknown>,
  p: AnyProfile<B, S, NL, ER>
): UplinkCtlDecoded<B, S> {
  const req: Extract<UplinkCtlDecoded<B, S>, { t: 'key.log.req' }> = {
    t: 'key.log.req',
    from_seq: p.seq(parsed.from_seq, 'from_seq'),
  };
  const id = p.optText(parsed.id, 'id');
  if (id) req.id = id;
  if (parsed.limit !== undefined && parsed.limit !== null) {
    req.limit = p.readers.posInt(parsed.limit, 'limit');
  }
  return req;
}

function decodeKeyLogRes<B, S, NL, ER>(
  parsed: Record<string, unknown>,
  p: AnyProfile<B, S, NL, ER>
): UplinkCtlDecoded<B, S> {
  if (!Array.isArray(parsed.records)) throw p.fail(p.keyLogRes.notArray);
  if (parsed.records.length > KEY_LOG_PAGE_MAX_LIMIT) {
    throw p.fail('key.log.res too many records');
  }
  const res: Extract<UplinkCtlDecoded<B, S>, { t: 'key.log.res' }> = {
    t: 'key.log.res',
    records: parsed.records.map((row, i) => {
      if (!isRecord(row)) throw p.fail(p.keyLogRes.notObject(i));
      return {
        seq: p.seq(row.seq, p.keyLogRes.field(i, 'seq')),
        bytes: p.bytes(row.bytes, p.keyLogRes.field(i, 'bytes')),
        sig: p.bytes(row.sig, p.keyLogRes.field(i, 'sig'), p.keyLogSigLen),
      };
    }),
  };
  const id = p.optText(parsed.id, 'id');
  if (id) res.id = id;
  const error = p.optText(parsed.error, 'error');
  if (error) res.error = error;
  if (parsed.has_more !== undefined && parsed.has_more !== null) {
    res.has_more = p.readers.bool(parsed.has_more, 'has_more');
  }
  if (parsed.retry_after_ms !== undefined && parsed.retry_after_ms !== null) {
    res.retry_after_ms = p.readers.nonNegInt(parsed.retry_after_ms, 'retry_after_ms');
  }
  return res;
}

function decodeKeyLogAppend<B, S, NL, ER>(
  parsed: Record<string, unknown>,
  p: AnyProfile<B, S, NL, ER>
): UplinkCtlDecoded<B, S> {
  const append: Extract<UplinkCtlDecoded<B, S>, { t: 'key.log.append' }> = {
    t: 'key.log.append',
    bytes: p.bytes(parsed.bytes, 'bytes'),
    sig: p.bytes(parsed.sig, 'sig', p.keyLogSigLen),
  };
  const id = p.optText(parsed.id, 'id');
  if (id) append.id = id;
  if (parsed.force !== undefined && parsed.force !== null) {
    append.force = p.readers.bool(parsed.force, 'force');
  }
  return append;
}

function decodeKeyLogAck<B, S, NL, ER>(
  parsed: Record<string, unknown>,
  p: AnyProfile<B, S, NL, ER>
): UplinkCtlDecoded<B, S> {
  const ok = p.readers.bool(parsed.ok, 'ok');
  const ack: Extract<UplinkCtlDecoded<B, S>, { t: 'key.log.ack' }> = {
    t: 'key.log.ack',
    id: p.reqText(parsed.id, 'id'),
    ok,
  };
  if (ok) ack.seq = p.seq(parsed.seq, 'seq');
  else ack.error = p.reqText(parsed.error, 'error');
  return ack;
}

function decodeRtcSignal<B, S, NL, ER>(
  parsed: Record<string, unknown>,
  p: AnyProfile<B, S, NL, ER>
): UplinkCtlDecoded<B, S> {
  const from = p.rtcFrom(parsed.from);
  const msg: Extract<UplinkCtlDecoded<B, S>, { t: 'rtc.signal' }> = {
    t: 'rtc.signal',
    rtcSession: p.reqText(parsed.rtcSession, 'rtcSession'),
    from,
    to: p.reqText(parsed.to, 'to'),
  };
  const sdp = p.optSignalText(parsed.sdp, 'sdp');
  if (sdp !== undefined) msg.sdp = sdp;
  const candidate = p.optSignalText(parsed.candidate, 'candidate');
  if (candidate !== undefined) msg.candidate = candidate;
  return msg;
}

function decodeEnrollRedeemed<B, S, NL, ER>(
  parsed: Record<string, unknown>,
  p: AnyProfile<B, S, NL, ER>
): ER {
  const fields: EnrollRedeemedFields<B> = {
    certificate: p.bytes(parsed.certificate, 'certificate', undefined, UPLINK_CTL_MAX_CERT_BYTES),
    certSig: p.bytes(parsed.cert_sig, 'cert_sig', 64),
    enrollPk: p.bytes(parsed.enroll_pk, 'enroll_pk', 32),
    nodeId: p.readers.nodeId(parsed.node_id, 'node_id'),
  };
  const entrySid = p.optText(parsed.entry_sid, 'entry_sid');
  if (entrySid) fields.entrySid = entrySid;
  if (
    p.keepAlreadyAdmitted === true &&
    parsed.already_admitted !== undefined &&
    parsed.already_admitted !== null
  ) {
    fields.alreadyAdmitted = p.readers.bool(parsed.already_admitted, 'already_admitted');
  }
  return p.enrollRedeemed(fields);
}

function decodeHubFrameCtl<B, S, NL, ER>(
  t: HubFrameCtlType,
  parsed: Record<string, unknown>,
  p: AnyProfile<B, S, NL, ER>
): HubFrameCtlMessage {
  switch (t) {
    case 'hub.tokens':
      return p.frame('invalid hub.tokens', () => parseHubTokensMessage(parsed));
    case 'hub.attachments':
      return p.frame('invalid hub.attachments', () => parseHubAttachmentsMessage(parsed));
    case 'hub.forward':
      return p.frame('invalid hub.forward', () => parseHubForwardMessage(parsed));
    case 'hub.write-forward':
      return p.frame('invalid hub.write-forward', () => parseHubWriteForwardMessage(parsed));
  }
}

/** 穷举 switch 是刻意的：新增 ctl 类型必须在此显式落地，表驱动会掩盖顺序语义。 */
function decodeCoreCtl<B, S, NL, ER>(
  t: CoreCtlType,
  parsed: Record<string, unknown>,
  p: AnyProfile<B, S, NL, ER>
): UplinkCtlDecoded<B, S> | NL | ER {
  switch (t) {
    case 'auth.challenge':
      return { t: 'auth.challenge', nonce: p.text(parsed.nonce, 'nonce', 32) };
    case 'auth.response':
      return {
        t: 'auth.response',
        node_id: p.nodeIdText(parsed.node_id, 'node_id'),
        sig: p.text(parsed.sig, 'sig', 64),
      };
    case 'auth.ok':
      return { t: 'auth.ok' };
    case 'ping':
      return { t: 'ping' };
    case 'pong':
      return { t: 'pong' };
    case 'node.status':
      return decodeNodeStatus(parsed, p);
    case 'node.list':
      return p.nodeList(parsed);
    case 'key.log.req':
      return decodeKeyLogReq(parsed, p);
    case 'key.log.res':
      return decodeKeyLogRes(parsed, p);
    case 'key.log.append':
      return decodeKeyLogAppend(parsed, p);
    case 'key.log.ack':
      return decodeKeyLogAck(parsed, p);
    case 'rtc.signal':
      return decodeRtcSignal(parsed, p);
    case 'enroll.redeemed':
      return decodeEnrollRedeemed(parsed, p);
  }
}

export function decodeUplinkCtl<B, S, NL, ER>(
  input: Uint8Array | string,
  profile: CtlDecodeProfile<B, S, NL, ER>,
  opts?: DecodeUplinkCtlOptions
): UplinkCtlDecoded<B, S> | NL | ER {
  const parsed = prepareCtl(input, profile, opts);
  const t = parsed.t as UplinkCtlType;
  if (isHubFrameCtlType(t)) return decodeHubFrameCtl(t, parsed, profile);
  return decodeCoreCtl(t, parsed, profile);
}
