import { wsBorsh } from '@vibeterm/shared';
import type { MeshServerWebSocket, RtcSignalRouter } from './mesh-deps';

type MeshSocketMessageDeps = {
  rtcSignals: RtcSignalRouter | null | undefined;
  send: (ws: MeshServerWebSocket, frame: Uint8Array) => void;
  nextSeq: () => number;
};

/** 浏览器 `/mesh/ws` 入站帧：PING 原样回 PONG（前台应用层探活），RTC_SIGNAL 转给信令；其余忽略。 */
export function dispatchMeshSocketMessage(
  deps: MeshSocketMessageDeps,
  ws: MeshServerWebSocket,
  bytes: Uint8Array
): void {
  try {
    const env = wsBorsh.decodeEnvelope(bytes);
    if (env.kind === wsBorsh.KIND_PING) {
      deps.send(ws, wsBorsh.encodeEnvelope(wsBorsh.KIND_PONG, env.payload, deps.nextSeq()));
      return;
    }
    if (!deps.rtcSignals || env.kind !== wsBorsh.KIND_RTC_SIGNAL) return;
    const payload = wsBorsh.decodePayload(wsBorsh.schema.RtcSignalSchema, env.payload);
    if (payload.from === wsBorsh.RTC_SIGNAL_FROM_NODE) return;
    const uid = ws.data.uid;
    const sid = ws.data.sid;
    deps.rtcSignals.send(
      {
        rtcSession: payload.rtcSession,
        from: 'browser',
        to: payload.to,
        sdp: payload.sdp,
        candidate: payload.candidate,
      },
      uid && sid ? { uid, sid } : undefined
    );
  } catch {}
}
