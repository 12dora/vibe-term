import type { APIRequestContext } from '@playwright/test';
import { type ThemeMode, wsBorsh } from '@tmex/shared';

// 与 playwright.config.ts / global-setup.ts 的 DEFAULT_GATEWAY_PORT 同步；
// 实际运行由 scripts/run-e2e.ts 注入 TMEX_E2E_GATEWAY_PORT。
const DEFAULT_GATEWAY_PORT = 9665;

function gatewayWsUrl(): string {
  const port = Number(process.env.TMEX_E2E_GATEWAY_PORT) || DEFAULT_GATEWAY_PORT;
  return `ws://127.0.0.1:${port}/ws`;
}

function themeCode(theme: ThemeMode): number {
  return theme === 'light' ? wsBorsh.SITE_THEME_LIGHT : wsBorsh.SITE_THEME_DARK;
}

/**
 * 把站点外观切成 theme，走产品唯一的上行通道：WS C2S `KIND_SITE_THEME_UPDATE`
 * （侧栏主题菜单 → useSiteStore.updateTheme → 同一帧）。
 *
 * setup/cleanup 阶段没有页面可用，故这里自开一条裸 WS：HELLO 协商后发一帧，
 * 再等服务端把 S2C 广播回来——收到即代表 gateway 已落库并向所有客户端广播。
 */
export function setSiteTheme(theme: ThemeMode, timeoutMs = 15_000): Promise<void> {
  const wanted = themeCode(theme);
  return new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(gatewayWsUrl());
    socket.binaryType = 'arraybuffer';
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error(`setSiteTheme(${theme}) timed out after ${timeoutMs}ms`)),
      timeoutMs
    );

    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // 已关闭
      }
      if (error) reject(error);
      else resolve();
    }

    socket.addEventListener('open', () => {
      const hello = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
        clientImpl: 'tmex-e2e-site-theme',
        clientVersion: '0.0.0',
        maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
        supportsCompression: false,
        supportsDiffSnapshot: false,
      });
      socket.send(wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_C2S, hello, 1));
    });

    socket.addEventListener('message', (event) => {
      const data: unknown = event.data;
      if (!(data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(data);
      if (!wsBorsh.checkMagic(bytes)) return;
      let envelope: wsBorsh.Envelope;
      try {
        envelope = wsBorsh.decodeEnvelope(bytes);
      } catch {
        return;
      }
      if (envelope.kind === wsBorsh.KIND_HELLO_S2C) {
        const payload = wsBorsh.encodePayload(wsBorsh.schema.SiteThemeUpdateC2SSchema, {
          theme: wanted,
        });
        socket.send(wsBorsh.encodeEnvelope(wsBorsh.KIND_SITE_THEME_UPDATE, payload, 2));
        return;
      }
      if (envelope.kind === wsBorsh.KIND_SITE_THEME_UPDATE) {
        const decoded = wsBorsh.decodePayload(
          wsBorsh.schema.SiteThemeUpdateS2CSchema,
          envelope.payload
        );
        if (decoded.theme === wanted) finish();
        return;
      }
      if (envelope.kind === wsBorsh.KIND_ERROR) {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.ErrorSchema, envelope.payload);
        finish(new Error(`setSiteTheme(${theme}) rejected: ${decoded.code} ${decoded.message}`));
      }
    });

    socket.addEventListener('error', () => {
      finish(new Error(`setSiteTheme(${theme}) websocket error on ${gatewayWsUrl()}`));
    });
    socket.addEventListener('close', () => {
      finish(new Error(`setSiteTheme(${theme}) socket closed before the S2C broadcast`));
    });
  });
}

/** 读当前站点外观：`GET /api/settings/site` 的 settings.theme。 */
export async function readSiteTheme(request: APIRequestContext): Promise<ThemeMode> {
  const res = await request.get('/api/settings/site');
  const body = (await res.json()) as { settings: { theme: ThemeMode } };
  return body.settings.theme;
}
