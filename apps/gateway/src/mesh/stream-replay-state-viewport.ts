import { wsBorsh } from '@tmex/shared';

/** 单条转发流最多记住多少条几何帧：pane 反复增删时不让这张表无界增长。 */
const MAX_VIEWPORT_REPLAY_FRAMES = 64;

const TAG_VIEWPORT = 'v';
const TAG_SELECT = 's';
const TAG_RESIZE = 'r';

/**
 * 浏览器声明式几何的重放缓存。
 *
 * entry↔node 切换会在节点侧新建 GatewaySession：旧会话的视口 claim、焦点与尺寸随它一起消失，
 * 而浏览器的物理 WS 并没有断开，不会自己重发。canonical 订阅之外的这几类帧因此必须由 entry 补发。
 * 按「最后一次写入」的顺序保存（同一 key 覆盖时移到队尾），补发时按同样顺序下发，
 * 让节点侧仲裁出的赢家与切换前一致；ResizePaneV11 改写成 geometryReason=resend、sizeEpoch 不变。
 */
export class ViewportReplayCache {
  private readonly frames = new Map<string, Uint8Array>();

  /** 记录一帧声明式几何；返回 true 表示这帧属于本缓存。 */
  noteFrame(env: wsBorsh.Envelope, bytes: Uint8Array): boolean {
    if (env.kind === wsBorsh.KIND_TERM_VIEWPORT) {
      const payload = wsBorsh.decodePayload(wsBorsh.schema.TermViewportSchema, env.payload);
      this.set(key(TAG_VIEWPORT, payload.deviceId, payload.paneId), bytes.slice());
      return true;
    }
    if (env.kind === wsBorsh.KIND_TMUX_SELECT) {
      const payload = wsBorsh.decodePayload(wsBorsh.schema.TmuxSelectSchema, env.payload);
      const scope = payload.windowId ?? payload.paneId;
      if (scope) this.set(key(TAG_SELECT, payload.deviceId, scope), bytes.slice());
      return true;
    }
    return false;
  }

  /** canonical v1.1 尺寸命令：缓存的永远是 resend 版本（补发不是一次新的视口变化）。 */
  noteResize(resize: wsBorsh.CanonicalResizePaneV11, seq: number): void {
    const frame = encodeResendFrame(resize, seq);
    if (!frame) return;
    this.set(key(TAG_RESIZE, resize.pane.deviceId, resize.pane.paneId), frame);
  }

  removeDevice(deviceId: string): void {
    for (const cached of this.frames.keys()) {
      if (cached.split('\0')[1] === deviceId) this.frames.delete(cached);
    }
  }

  replayFrames(): Uint8Array[] {
    return [...this.frames.values()];
  }

  size(): number {
    return this.frames.size;
  }

  private set(cacheKey: string, frame: Uint8Array): void {
    this.frames.delete(cacheKey);
    this.frames.set(cacheKey, frame);
    while (this.frames.size > MAX_VIEWPORT_REPLAY_FRAMES) {
      const oldest = this.frames.keys().next();
      if (oldest.done) return;
      this.frames.delete(oldest.value);
    }
  }
}

function key(tag: string, deviceId: string, scopeId: string): string {
  return `${tag}\0${deviceId}\0${scopeId}`;
}

function encodeResendFrame(resize: wsBorsh.CanonicalResizePaneV11, seq: number): Uint8Array | null {
  try {
    return wsBorsh.encodeEnvelope(
      wsBorsh.KIND_CANONICAL_COMMAND,
      wsBorsh.encodeCanonicalCommandPayload({
        ResizePaneV11: {
          ...resize,
          geometryReason: wsBorsh.CANONICAL_GEOMETRY_REASON_RESEND,
        },
      }),
      seq
    );
  } catch {
    return null;
  }
}
