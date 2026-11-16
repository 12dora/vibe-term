import { describe, expect, test } from 'bun:test';
import { lazyRouteGroup } from './lazy-routes';
import { type ApiRoute, dispatchRoutes, route } from './route';

function counted(): { load: () => Promise<ApiRoute[]>; count: () => number } {
  let loads = 0;
  return {
    count: () => loads,
    load: async () => {
      loads++;
      return [
        route({
          method: 'GET',
          path: '/api/demo/items/:id',
          handler: (_req, params) => Response.json({ id: params.id }),
        }),
      ];
    },
  };
}

function dispatch(routes: ApiRoute[], method: string, path: string) {
  const req = new Request(`http://localhost${path}`, { method });
  return dispatchRoutes(req, path, routes, { path });
}

describe('lazyRouteGroup', () => {
  test('first matching request loads the group once; later requests reuse it', async () => {
    const source = counted();
    const routes = [lazyRouteGroup('/api/demo', source.load)];
    expect(source.count()).toBe(0);
    const [first, second] = await Promise.all([
      dispatch(routes, 'GET', '/api/demo/items/1'),
      dispatch(routes, 'GET', '/api/demo/items/2'),
    ]);
    expect(await first?.json()).toEqual({ id: '1' });
    expect(await second?.json()).toEqual({ id: '2' });
    const third = await dispatch(routes, 'GET', '/api/demo/items/3');
    expect(await third?.json()).toEqual({ id: '3' });
    expect(source.count()).toBe(1);
  });

  test('paths outside the prefix never trigger a load', () => {
    const source = counted();
    expect(dispatch([lazyRouteGroup('/api/demo', source.load)], 'GET', '/api/other')).toBe(
      undefined
    );
    expect(source.count()).toBe(0);
  });

  test('unmatched path: 404 while loading, falls through once loaded', async () => {
    const source = counted();
    const fallback = route({
      method: '*',
      path: '/api/demo/*',
      handler: () => new Response('fallback'),
    });
    const routes: ApiRoute<string>[] = [
      lazyRouteGroup('/api/demo', source.load),
      fallback as unknown as ApiRoute<string>,
    ];
    const loading = await dispatch(routes, 'POST', '/api/demo/items/1');
    expect(loading?.status).toBe(404);
    expect(await loading?.json()).toMatchObject({ code: 'route_not_found' });
    const loaded = await dispatch(routes, 'POST', '/api/demo/items/1');
    expect(await loaded?.text()).toBe('fallback');
  });

  test('a failed load is retried on the next request', async () => {
    let attempts = 0;
    const routes = [
      lazyRouteGroup('/api/demo', async () => {
        attempts++;
        if (attempts === 1) throw new Error('boom');
        return counted().load();
      }),
    ];
    await expect(Promise.resolve(dispatch(routes, 'GET', '/api/demo/items/1'))).rejects.toThrow(
      'boom'
    );
    const retried = await dispatch(routes, 'GET', '/api/demo/items/1');
    expect(await retried?.json()).toEqual({ id: '1' });
    expect(attempts).toBe(2);
  });

  test('only the exact base and its sub-paths belong to the group', () => {
    const source = counted();
    const routes = [lazyRouteGroup('/api/demo', source.load)];
    expect(dispatch(routes, 'GET', '/api/demos')).toBeUndefined();
    expect(dispatch(routes, 'GET', '/api/demo-x/1')).toBeUndefined();
    expect(source.count()).toBe(0);
  });

  test('prepare runs on every request while not ready, not only on the first load', async () => {
    const source = counted();
    let ready = false;
    let prepares = 0;
    const routes = [
      lazyRouteGroup('/api/demo', source.load, {
        ready: () => ready,
        prepare: async () => {
          prepares++;
          ready = true;
        },
      }),
    ];
    expect(await (await dispatch(routes, 'GET', '/api/demo/items/1'))?.json()).toEqual({ id: '1' });
    expect(prepares).toBe(1);
    await dispatch(routes, 'GET', '/api/demo/items/2');
    expect(prepares).toBe(1);
    // 模拟同进程重启后服务被 stop：下一次请求必须重新 prepare
    ready = false;
    await dispatch(routes, 'GET', '/api/demo/items/3');
    expect(prepares).toBe(2);
    expect(source.count()).toBe(1);
  });
});
