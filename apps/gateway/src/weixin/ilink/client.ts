// WeixinClient：iLink bot 协议的高层客户端。
// 负责登录（扫码）、长轮询收消息、context_token 缓存、发送文本。

import { sleepOrAbort } from '@tmex/shared';
import { type FetchImpl, getBotQrcode, getQrcodeStatus, sendMessage } from './api';
import {
  CLIENT_ID_PREFIX,
  type GetQrcodeStatusResp,
  ITEM_TYPE_TEXT,
  SESSION_EXPIRED_ERRCODE,
  type WeixinCredentials,
  type WeixinInboundMessage,
  type WeixinMessage,
} from './types';
import { AbortError, WeixinSessionExpiredError, isAbort, runUpdateLoop } from './update-loop';

export { WeixinSessionExpiredError };

export class WeixinNoContextTokenError extends Error {
  constructor(toUserId: string) {
    super(`No context_token for user ${toUserId}. Receive a message from them first.`);
    this.name = 'WeixinNoContextTokenError';
  }
}

export interface WeixinClientOptions extends Partial<WeixinCredentials> {
  fetchImpl?: FetchImpl;
}

export interface WeixinStartOptions {
  signal?: AbortSignal;
  loadSyncBuf?: () => string | undefined | Promise<string | undefined>;
  saveSyncBuf?: (buf: string) => void | Promise<void>;
  initialContextTokens?: Record<string, string>;
  onMessage?: (msg: WeixinInboundMessage) => void | Promise<void>;
  onSessionExpired?: () => void;
  onError?: (err: unknown) => void;
  /** 长轮询 per-request 超时初值（毫秒）；省略用默认 60s，之后按服务端 longpolling_timeout_ms 调整。 */
  longpollTimeoutMs?: number;
}

export interface WeixinLoginOptions {
  onQrcode: (qr: { url: string; qrcodeId: string }) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

const DEFAULT_LOGIN_TIMEOUT_MS = 480_000;
const DEFAULT_QRCODE_POLL_INTERVAL_MS = 1_000;
const MAX_QRCODE_REFRESH = 3;

function generateClientId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${CLIENT_ID_PREFIX}${hex}`;
}

export class WeixinClient {
  private creds: WeixinCredentials | null = null;
  private readonly fetchImpl?: FetchImpl;
  private readonly contextTokens = new Map<string, string>();
  private running = false;
  private internalAbort: AbortController | null = null;

  constructor(opts: WeixinClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl;
    if (opts.accountId && opts.botToken && opts.baseUrl) {
      this.creds = {
        accountId: opts.accountId,
        botToken: opts.botToken,
        baseUrl: opts.baseUrl,
      };
    }
  }

  get credentials(): WeixinCredentials | null {
    return this.creds;
  }

  getContextToken(userId: string): string | undefined {
    return this.contextTokens.get(userId);
  }

  setContextToken(userId: string, token: string): void {
    this.contextTokens.set(userId, token);
  }

  isRunning(): boolean {
    return this.running;
  }

  static extractText(raw: unknown): string {
    const msg = raw as WeixinMessage | null | undefined;
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.item_list)) {
      return '';
    }
    const parts: string[] = [];
    for (const item of msg.item_list) {
      if (item?.type === ITEM_TYPE_TEXT && typeof item.text_item?.text === 'string') {
        parts.push(item.text_item.text);
      }
    }
    return parts.join('');
  }

  async login(opts: WeixinLoginOptions): Promise<WeixinCredentials> {
    const { onQrcode, signal } = opts;
    const timeoutMs = Math.max(1_000, opts.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_QRCODE_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;

    let qrcodeId = await this.fetchQrcode(onQrcode, signal);
    let refreshes = 0;

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new AbortError();
      if (!(await sleepOrAbort(pollIntervalMs, signal))) throw new AbortError();

      let status: GetQrcodeStatusResp;
      try {
        status = await getQrcodeStatus(qrcodeId, {
          fetchImpl: this.fetchImpl,
          signal,
        });
      } catch (err) {
        // 用户取消 / stop 才中止；扫码窗口长达数分钟，单次网络抖动 / 5xx 不应判负，
        // 等下一拍重试，直到 deadline 才超时退出。
        if (isAbort(err, signal)) throw err;
        continue;
      }

      switch (status.status) {
        case 'confirmed': {
          if (!status.bot_token || !status.baseurl) {
            throw new Error('iLink login confirmed but bot_token/baseurl missing.');
          }
          const accountId = status.ilink_bot_id ?? status.ilink_user_id ?? status.bot_token;
          this.creds = {
            accountId,
            botToken: status.bot_token,
            baseUrl: status.baseurl,
          };
          return this.creds;
        }
        case 'expired': {
          if (refreshes >= MAX_QRCODE_REFRESH) {
            throw new Error('iLink qrcode expired and refresh limit reached.');
          }
          refreshes += 1;
          qrcodeId = await this.fetchQrcode(onQrcode, signal);
          break;
        }
        // 'wait' / 'scaned' / undefined：继续轮询
        default:
          break;
      }
    }

    throw new Error('iLink login timed out.');
  }

  private async fetchQrcode(
    onQrcode: WeixinLoginOptions['onQrcode'],
    signal?: AbortSignal
  ): Promise<string> {
    const resp = await getBotQrcode({ fetchImpl: this.fetchImpl, signal });
    if (!resp.qrcode) {
      throw new Error('iLink get_bot_qrcode returned no qrcode.');
    }
    if (!resp.qrcode_img_content) {
      // qrcode_img_content 实为二维码要编码的 URL（非图片本身），前端据此生成二维码；
      // 缺失则 fail-loud，不回退到 qrcode（那是轮询 ID）。
      throw new Error('iLink get_bot_qrcode returned no qrcode content.');
    }
    onQrcode({
      url: resp.qrcode_img_content,
      qrcodeId: resp.qrcode,
    });
    return resp.qrcode;
  }

  async start(opts: WeixinStartOptions = {}): Promise<void> {
    if (!this.creds) {
      throw new Error('WeixinClient.start called without credentials; login first.');
    }
    if (this.running) {
      throw new Error('WeixinClient already running.');
    }

    if (opts.initialContextTokens) {
      for (const [userId, token] of Object.entries(opts.initialContextTokens)) {
        this.contextTokens.set(userId, token);
      }
    }

    this.internalAbort = new AbortController();
    const signal = this.linkSignals(opts.signal, this.internalAbort.signal);
    this.running = true;

    try {
      await runUpdateLoop({
        credentials: this.creds,
        signal,
        fetchImpl: this.fetchImpl,
        loadCursor: opts.loadSyncBuf,
        saveCursor: opts.saveSyncBuf,
        onMessage: opts.onMessage,
        onContextToken: (userId, token) => {
          this.contextTokens.set(userId, token);
        },
        toInbound: (msg) => this.toInbound(msg),
        onSessionExpired: opts.onSessionExpired,
        onError: opts.onError,
        longpollTimeoutMs: opts.longpollTimeoutMs,
      });
    } finally {
      this.running = false;
      this.internalAbort = null;
    }
  }

  stop(): void {
    this.internalAbort?.abort();
  }

  async sendText(toUserId: string, text: string, contextToken?: string): Promise<void> {
    if (!this.creds) {
      throw new Error('WeixinClient.sendText called without credentials; login first.');
    }
    const token = contextToken ?? this.contextTokens.get(toUserId);
    if (!token) {
      throw new WeixinNoContextTokenError(toUserId);
    }
    const resp = await sendMessage({
      baseUrl: this.creds.baseUrl,
      botToken: this.creds.botToken,
      toUserId,
      contextToken: token,
      clientId: generateClientId(),
      items: [{ text }],
      fetchImpl: this.fetchImpl,
    });
    if (resp.ret === SESSION_EXPIRED_ERRCODE || resp.errcode === SESSION_EXPIRED_ERRCODE) {
      throw new WeixinSessionExpiredError();
    }
    if (typeof resp.ret === 'number' && resp.ret !== 0) {
      throw new Error(`sendmessage ret=${resp.ret} errmsg=${resp.errmsg ?? ''}`);
    }
  }

  private toInbound(msg: WeixinMessage): WeixinInboundMessage {
    return {
      fromUserId: msg.from_user_id ?? '',
      contextToken: msg.context_token ?? null,
      text: WeixinClient.extractText(msg),
      raw: msg,
    };
  }

  // 把外部 signal 与内部 stop() signal 合并成一个。
  private linkSignals(external: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
    if (!external) return internal;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (external.aborted || internal.aborted) {
      controller.abort();
      return controller.signal;
    }
    external.addEventListener('abort', onAbort, { once: true });
    internal.addEventListener('abort', onAbort, { once: true });
    return controller.signal;
  }
}
