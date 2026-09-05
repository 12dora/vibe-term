import type { LinkSession, LinkStream } from '@tmex/shared/link';
import type { OpenedWsStream } from './mesh-deps';
import { decodeTerminalStreamClose } from './stream-close-code';
import { openWsStream } from './stream-targets';

type CloseInfo = { code?: number; reason?: string };

type OpenedLinkWsStream = {
  stream: Pick<LinkStream, 'id' | 'closed' | 'onAbort'>;
  send: (bytes: Uint8Array) => Promise<void>;
  readable: ReadableStream<Uint8Array>;
  close: () => void;
};

/**
 * 把 link 上的 ws 流适配成 forwarder 的 `OpenedWsStream`。
 * 关闭结果会缓存：Hub 建流到浏览器 socket open 之间有时间窗，
 * 晚注册的 `onClose` 必须立刻拿到已发生的关闭码（否则撤销的 4410 会永久丢失）。
 */
export function adaptWsStream(opened: OpenedLinkWsStream): OpenedWsStream {
  const messageCbs: Array<(bytes: Uint8Array) => void> = [];
  const closeCbs: Array<(info: CloseInfo) => void> = [];
  let closedInfo: CloseInfo | null = null;
  const notifyClose = (info: CloseInfo) => {
    if (closedInfo) return;
    closedInfo = info;
    for (const cb of closeCbs) {
      try {
        cb(info);
      } catch {}
    }
    closeCbs.length = 0;
  };
  // RST 的 reason 会随帧到达；只有它能区分「节点端主动终止」和链路抖动。
  const settledTerminalClose = async (): Promise<{ code: number; reason: string } | null> => {
    const info = await Promise.race([
      opened.stream.closed.catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 0)),
    ]);
    if (!info || info.reason !== 'rst') return null;
    return decodeTerminalStreamClose(info.message);
  };
  const reader = opened.readable.getReader();
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) for (const cb of messageCbs) cb(value);
      }
      notifyClose({});
    } catch {
      notifyClose((await settledTerminalClose()) ?? { code: 1011, reason: 'stream-error' });
    }
  })();
  opened.stream.onAbort(() => {
    void (async () => {
      notifyClose((await settledTerminalClose()) ?? { code: 1011, reason: 'reset' });
    })();
  });
  return {
    muxStreamId: opened.stream.id,
    send(bytes) {
      return opened.send(bytes);
    },
    onMessage(cb) {
      messageCbs.push(cb);
    },
    onClose(cb) {
      if (closedInfo) {
        try {
          cb(closedInfo);
        } catch {}
        return;
      }
      closeCbs.push(cb);
    },
    close(_code, reason) {
      try {
        opened.close();
      } catch {}
      notifyClose({ reason });
    },
  };
}

export async function openAdaptedWsStream(
  link: LinkSession,
  auth: string,
  cid?: string,
  share?: string
): Promise<OpenedWsStream> {
  return adaptWsStream(await openWsStream(link, auth, cid, share));
}
