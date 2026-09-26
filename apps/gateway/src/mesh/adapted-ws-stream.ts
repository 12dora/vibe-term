import type { LinkSession, LinkStream, StreamCloseInfo } from '@vibeterm/shared/link';
import type { OpenedWsStream } from './mesh-deps';
import { decodeTerminalStreamClose } from './stream-close-code';
import { openWsStream } from './stream-targets';

type CloseInfo = { code?: number; reason?: string };

type OpenedLinkWsStream = {
  stream: Pick<LinkStream, 'id' | 'closed' | 'onAbort'>;
  send: (bytes: Uint8Array) => Promise<void>;
  readable: ReadableStream<Uint8Array>;
  close: (reason?: string) => void;
};

function waitStreamCloseInfo(stream: Pick<LinkStream, 'closed'>): Promise<StreamCloseInfo | null> {
  return Promise.race([
    stream.closed.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 0)),
  ]);
}

/**
 * 普通收尾（head-timeout / link-closed / retired / peer-rst / aborted）原样透传，
 * 只有编码过的终止 RST 才是 4401 / 4410。切勿把链路抖动改写成 NODE_LOGIN_REQUIRED。
 */
function adaptedCloseFromStream(info: StreamCloseInfo): CloseInfo {
  if (info.reason === 'rst') {
    const terminal = decodeTerminalStreamClose(info.message);
    if (terminal) return terminal;
  }
  const reason = info.message?.trim() || info.reason;
  return { code: 1011, reason };
}

function settleAdaptedClose(
  notifyClose: (info: CloseInfo) => void,
  stream: Pick<LinkStream, 'closed'>,
  fallback: CloseInfo
): void {
  void waitStreamCloseInfo(stream).then((info) => {
    notifyClose(info ? adaptedCloseFromStream(info) : fallback);
  });
}

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
      settleAdaptedClose(notifyClose, opened.stream, { code: 1011, reason: 'stream-error' });
    }
  })();
  opened.stream.onAbort(() => {
    settleAdaptedClose(notifyClose, opened.stream, { code: 1011, reason: 'reset' });
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
        opened.close(reason);
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
