import { readNodeEnv } from '../../../../packages/shared/src/env/load-env';
import { config } from '../config';
import { runtimeController } from '../control/runtime';
import { getSiteSettings } from '../db';
import { t } from '../i18n';
import { handleCapabilitiesApiRequest } from './capabilities';
import { createGatewayOwnerProof } from './gateway-ownership';
import { json, manifestJson } from './http';
import { type ApiRoute, route } from './route';
import { getTmuxHealth } from './tmux-health';
import { handleTmuxTreeApiRequest } from './tmux-tree';

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

export const capabilitiesRoutes: ApiRoute[] = [
  route({
    method: '*',
    path: '/api/capabilities',
    handler: (req, _params, ctx) => handleCapabilitiesApiRequest(req, ctx.path),
  }),
];

export const tmuxTreeRoutes: ApiRoute[] = [
  route({
    method: '*',
    path: '/api/tmux/tree',
    handler: (req, _params, ctx) => handleTmuxTreeApiRequest(req, ctx.path),
  }),
];

export const systemPrefixRoutes: ApiRoute[] = [
  route({
    method: '*',
    path: '/api/system/*',
    handler: (req, _params, ctx) => ctx.systemApiHandler?.(req, ctx.path),
  }),
];

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
      getTmuxHealth().then((tmux) => {
        return json({
          status: 'ok',
          restarting: runtimeController.isRestarting(),
          // 供 e2e globalSetup 断言「连到的是 test 实例而非生产」，避免误改生产数据。
          env: readNodeEnv(),
          tmux,
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
