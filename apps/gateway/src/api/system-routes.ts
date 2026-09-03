import { readNodeEnv } from '../../../../packages/shared/src/env/load-env';
import { config } from '../config';
import { runtimeController } from '../control/runtime';
import { getSiteSettings } from '../db';
import { getBaseVersion } from '../system/version';
import { createGatewayOwnerProof } from './gateway-ownership';
import { json, manifestJson } from './http';
import { type ApiRoute, route } from './route';
import { getTmuxHealth } from './tmux-health';

export type HealthzTlsInfo = {
  mode: string;
  listenerRunning: boolean;
};

let tlsHealthProvider: (() => Promise<HealthzTlsInfo> | HealthzTlsInfo) | null = null;

export function setHealthzTlsProvider(
  provider: (() => Promise<HealthzTlsInfo> | HealthzTlsInfo) | null
): void {
  tlsHealthProvider = provider;
}

async function handleGetManifest(method: 'GET' | 'HEAD'): Promise<Response> {
  const settings = getSiteSettings();

  const manifest = {
    id: '/',
    name: settings.siteName,
    short_name: settings.siteName,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0b1020',
    theme_color: '#0b1020',
    icons: [
      {
        src: '/tmex.png',
        sizes: '1024x1024',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/tmex-maskable.png',
        sizes: '1024x1024',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };

  return manifestJson(manifest, method);
}

export const systemPrefixRoutes: ApiRoute[] = [
  route({
    method: '*',
    path: '/api/system/*',
    handler: (req, _params, ctx) => ctx.systemApiHandler?.(req, ctx.path),
  }),
];

/** Process start time (`Date.now()` at module load). Exposed on `/healthz`. */
export const PROCESS_STARTED_AT = Date.now();

export const healthRoutes: ApiRoute[] = [
  route({
    method: ['GET', 'HEAD'],
    path: '/api/manifest.webmanifest',
    handler: (req) => handleGetManifest(req.method as 'GET' | 'HEAD'),
  }),
  route({
    method: 'GET',
    path: '/healthz',
    handler: (req) =>
      getTmuxHealth().then(async (tmux) => {
        const tls = tlsHealthProvider
          ? await tlsHealthProvider()
          : { mode: 'none', listenerRunning: false };
        return json({
          status: 'ok',
          version: getBaseVersion(),
          startedAt: PROCESS_STARTED_AT,
          restarting: runtimeController.isRestarting(),
          // 供 e2e globalSetup 断言「连到的是 test 实例而非生产」，避免误改生产数据。
          env: readNodeEnv(),
          tmux,
          tls,
          owner: createGatewayOwnerProof(
            config.gatewayOwnerToken,
            req.headers.get('x-tmex-gateway-challenge'),
            process.pid,
            tmux.healthy
          ),
        });
      }),
  }),
];
