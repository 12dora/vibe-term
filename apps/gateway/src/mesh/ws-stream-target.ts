import { wsBorsh } from '@vibeterm/shared';
import type { LinkSession, LinkStream } from '@vibeterm/shared/link';
import type { WebSocketServer } from '../ws';
import type { GatewaySession } from '../ws/gateway-session';
import { encodeJsonBytes } from './ctl';
import { LinkStreamCarrier } from './link-stream-carrier';
import { WS_CLOSE_LOGIN_REQUIRED } from './mesh-deps';
import { debugLine, warnLine } from './mesh-log';
import { parseOpenPayload } from './peer-protocol';
import { type StreamAuthContext, createStreamRecheck, verifyStreamAuth } from './stream-auth';
import { decodeTerminalStreamClose, encodeTerminalStreamClose } from './stream-close-code';
import type { WsStreamOpenPayload } from './types';

/**
 * 非鉴权拆流用的关闭码：链路断、帧解析失败、对端收流都归它。入口拿到的是非终止码，
 * 会当成链路抖动去 failover / 续流，而不是把「需要重新登录」透给浏览器。
 */
export const WS_CLOSE_STREAM_TEARDOWN = 1006;

export type GatewaySessionClose = { code: number; reason: string };

export type AcceptWsStreamOptions = StreamAuthContext & {
  wsServer: WebSocketServer;
  onGatewaySession?: (
    session: GatewaySession,
    auth: { sid: string; uid: string; via: string; cid?: string }
  ) => boolean | undefined;
  onGatewaySessionClose?: (session: GatewaySession, close?: GatewaySessionClose) => void;
};

type AttachedStreamSession = ReturnType<WebSocketServer['attachStreamSession']>;
type WsTeardownMode = 'end' | 'rst' | 'auth';
type WsStreamTeardown = (mode: WsTeardownMode, reason?: string) => void;

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function logAuthRejected(peerNodeId: string, cid: string, reason: string): void {
  warnLine(
    '[mesh][stream]',
    `session rejected node=${peerNodeId} cid=${cid || '-'} reason=${reason}`
  );
}

function logTeardown(peerNodeId: string, cid: string, mode: string, reason: string): void {
  debugLine(
    '[mesh][stream]',
    `teardown node=${peerNodeId} cid=${cid || '-'} mode=${mode} reason=${reason}`
  );
}

/**
 * 鉴权失败的关闭三元组。分享凭证的 reason 已经是编码好的终止串（4410 / 4401），原样沿用；
 * 常规会话统一编成 4401，真实原因（expired / via_mismatch / revoked / unknown）追加在
 * `NODE_LOGIN_REQUIRED` 之后——旧版入口只解前半段的 code，浏览器也只认 4401。
 */
function authTeardownClose(reason: string): GatewaySessionClose & { reset: string } {
  const decoded = decodeTerminalStreamClose(reason);
  if (decoded) return { ...decoded, reset: reason };
  const detail = `NODE_LOGIN_REQUIRED:${reason}`;
  return {
    code: WS_CLOSE_LOGIN_REQUIRED,
    reason: detail,
    reset: encodeTerminalStreamClose(WS_CLOSE_LOGIN_REQUIRED, detail),
  };
}

export async function acceptWsStream(
  stream: LinkStream,
  opts: AcceptWsStreamOptions
): Promise<void> {
  const open = parseOpenPayload(stream.openPayload) ?? {};
  const auth = str(open.auth);
  const boundShareId = str(open.share).trim() || null;
  const cid = (str(open.cid) || str(open.connectionId)).trim();
  const verified = verifyStreamAuth(auth, '/ws', opts, boundShareId);
  if (!verified.ok) {
    logAuthRejected(opts.peerNodeId, cid, verified.reason);
    stream.reset(authTeardownClose(verified.wsClose ?? verified.reason).reset);
    return;
  }
  const share = verified.share;
  const carrier = new LinkStreamCarrier(stream, {
    logContext: { kind: 'mesh_link_stream', nodeId: opts.peerNodeId, ...(cid ? { cid } : {}) },
  });
  const attached = opts.wsServer.attachStreamSession(carrier, { shareScope: share?.scope });
  const teardown = wsStreamTeardown(stream, attached, {
    peerNodeId: opts.peerNodeId,
    cid,
    registry: share ? undefined : opts,
  });
  if (!share && opts.onGatewaySession) {
    const accepted = opts.onGatewaySession(attached.session, {
      sid: auth,
      uid: verified.uid ?? '',
      via: opts.peerNodeId,
      ...(cid ? { cid } : {}),
    });
    if (accepted === false) {
      teardown('rst', 'duplicate-connection');
      return;
    }
  }
  stream.onAbort(() => teardown('rst', 'peer-rst'));
  await pumpWsStreamFrames(stream, attached, teardown, createStreamRecheck(auth, share, opts));
}

/**
 * 只有 `'auth'` 会把会话关成 4401：会话复验真的失败了，重连也不会成功。链路侧的拆流
 * （对端收流、RST、读失败、帧非法）一律用非终止码，否则入口会把每一次链路抖动都当成
 * 「该节点需要重新登录」透给浏览器，浏览器再登录再断，表现为节点永远停在「连接中」。
 */
function wsStreamTeardown(
  stream: LinkStream,
  attached: AttachedStreamSession,
  ctx: {
    peerNodeId: string;
    cid: string;
    registry: Pick<AcceptWsStreamOptions, 'onGatewaySessionClose'> | undefined;
  }
): WsStreamTeardown {
  let tornDown = false;
  return (mode, reason) => {
    if (tornDown) return;
    tornDown = true;
    const detail = reason ?? (mode === 'auth' ? 'session-invalid' : mode);
    const auth = mode === 'auth' ? authTeardownClose(detail) : null;
    if (auth) logAuthRejected(ctx.peerNodeId, ctx.cid, detail);
    else logTeardown(ctx.peerNodeId, ctx.cid, mode, detail);
    const close: GatewaySessionClose = auth ?? { code: WS_CLOSE_STREAM_TEARDOWN, reason: detail };
    try {
      ctx.registry?.onGatewaySessionClose?.(attached.session, close);
    } catch {
      // registry
    }
    try {
      attached.onClose(close.code, close.reason);
    } catch {
      // session already gone
    }
    try {
      if (mode === 'end') void stream.end().catch(() => {});
      else stream.reset(auth ? auth.reset : detail);
    } catch {
      // already closed
    }
  };
}

async function pumpWsStreamFrames(
  stream: LinkStream,
  attached: AttachedStreamSession,
  teardown: WsStreamTeardown,
  recheck: () => string | null
): Promise<void> {
  const reader = stream.readable.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        teardown('end');
        return;
      }
      if (!value) continue;
      let envelope: wsBorsh.Envelope;
      try {
        envelope = wsBorsh.decodeEnvelopeView(value.bytes);
      } catch {
        teardown('rst', 'invalid-ws-frame');
        return;
      }
      const invalid = recheck();
      if (invalid) {
        teardown('auth', invalid);
        return;
      }
      attached.onDecodedEnvelope(envelope);
    }
  } catch {
    teardown('rst', 'ws-read-failed');
  }
}

export async function openWsStream(
  link: LinkSession,
  auth: string,
  cid?: string,
  share?: string
): Promise<{
  stream: LinkStream;
  send: (bytes: Uint8Array) => Promise<void>;
  readable: ReadableStream<Uint8Array>;
  close: () => void;
}> {
  const payload: WsStreamOpenPayload = {
    type: 'ws',
    auth,
    ...(cid ? { cid } : {}),
    ...(share ? { share } : {}),
  };
  const stream = await link.openStream(encodeJsonBytes(payload));
  return {
    stream,
    send: (bytes) => stream.write(bytes),
    readable: stream.readable.pipeThrough(
      new TransformStream<{ bytes: Uint8Array; head: boolean }, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk.bytes);
        },
      })
    ),
    close: () => {
      void stream.end().catch(() => {});
    },
  };
}
