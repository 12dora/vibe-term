import { describe, expect, test } from 'bun:test';
import { type ApiRoute, dispatchRoutes, matchPath, methodMatches } from './route';

describe('matchPath', () => {
  test('matches a static path and returns empty params', () => {
    expect(matchPath('/api/devices', '/api/devices')).toEqual({});
  });

  test('rejects a static path with extra segments', () => {
    expect(matchPath('/api/devices/x', '/api/devices')).toBeNull();
  });

  test('extracts a single :param without decoding', () => {
    expect(matchPath('/api/devices/abc%2Fdef', '/api/devices/:id')).toEqual({
      id: 'abc%2Fdef',
    });
  });

  test('extracts nested params', () => {
    expect(
      matchPath(
        '/api/settings/telegram/bots/bot1/chats/chat%3A2/approve',
        '/api/settings/telegram/bots/:botId/chats/:chatId/approve'
      )
    ).toEqual({ botId: 'bot1', chatId: 'chat%3A2' });
  });

  test('rejects empty param segments', () => {
    expect(matchPath('/api/devices/', '/api/devices/:id')).toBeNull();
  });

  test('rejects trailing extra segments on a param pattern', () => {
    expect(matchPath('/api/devices/x/extra', '/api/devices/:id')).toBeNull();
  });

  test('prefix * uses startsWith, including the empty remainder', () => {
    expect(matchPath('/api/files', '/api/files*')).toEqual({ '*': '' });
    expect(matchPath('/api/files/roots', '/api/files*')).toEqual({ '*': '/roots' });
    expect(matchPath('/api/filesXYZ', '/api/files*')).toEqual({ '*': 'XYZ' });
    expect(matchPath('/api/file', '/api/files*')).toBeNull();
  });

  test('slash-terminated prefix * requires the slash', () => {
    expect(matchPath('/api/llm', '/api/llm/*')).toBeNull();
    expect(matchPath('/api/llm/', '/api/llm/*')).toEqual({ '*': '' });
    expect(matchPath('/api/llm/providers', '/api/llm/*')).toEqual({ '*': 'providers' });
  });
});

describe('methodMatches', () => {
  test('matches a single method exactly', () => {
    expect(methodMatches('GET', 'GET')).toBe(true);
    expect(methodMatches('POST', 'GET')).toBe(false);
  });

  test('matches any of an array of methods', () => {
    expect(methodMatches('HEAD', ['GET', 'HEAD'])).toBe(true);
    expect(methodMatches('PUT', ['GET', 'HEAD'])).toBe(false);
  });

  test('wildcard method matches any verb', () => {
    expect(methodMatches('OPTIONS', '*')).toBe(true);
  });
});

describe('dispatchRoutes priority', () => {
  function tagged(path: string): ApiRoute['handler'] {
    return (_req, params) =>
      new Response(JSON.stringify({ path, params }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
  }

  const routes: ApiRoute[] = [
    { method: 'GET', path: '/api/devices', handler: tagged('/api/devices') },
    { method: 'PUT', path: '/api/devices/order', handler: tagged('/api/devices/order') },
    { method: 'GET', path: '/api/devices/:id', handler: tagged('/api/devices/:id') },
    {
      method: 'POST',
      path: '/api/devices/:id/test-connection',
      handler: tagged('/api/devices/:id/test-connection'),
    },
    { method: '*', path: '/api/devices/*', handler: tagged('/api/devices/*') },
    {
      method: ['GET', 'HEAD'],
      path: '/api/manifest.webmanifest',
      handler: tagged('/api/manifest.webmanifest'),
    },
  ];

  async function dispatch(
    method: string,
    pathname: string
  ): Promise<{ path: string; params: Record<string, string> } | null> {
    const req = new Request(`http://localhost${pathname}`, { method });
    const result = dispatchRoutes(req, pathname, routes, {
      server: {} as never,
      path: pathname,
    });
    if (!result) return null;
    const res = await result;
    return (await res.json()) as { path: string; params: Record<string, string> };
  }

  test('fixed /api/devices/order wins over /api/devices/:id', async () => {
    const matched = await dispatch('PUT', '/api/devices/order');
    expect(matched?.path).toBe('/api/devices/order');
    expect(matched?.params).toEqual({});
  });

  test('GET /api/devices/order does not take the PUT order route and matches :id', async () => {
    const matched = await dispatch('GET', '/api/devices/order');
    expect(matched?.path).toBe('/api/devices/:id');
    expect(matched?.params).toEqual({ id: 'order' });
  });

  test('GET /api/devices/:id extracts the id', async () => {
    const matched = await dispatch('GET', '/api/devices/dev-1');
    expect(matched?.path).toBe('/api/devices/:id');
    expect(matched?.params).toEqual({ id: 'dev-1' });
  });

  test('list route is preferred over :id for the collection path', async () => {
    const matched = await dispatch('GET', '/api/devices');
    expect(matched?.path).toBe('/api/devices');
  });

  test('later prefix route only matches leftover device paths', async () => {
    const matched = await dispatch('GET', '/api/devices/dev-1/unknown-subpath');
    expect(matched?.path).toBe('/api/devices/*');
    expect(matched?.params).toEqual({ '*': 'dev-1/unknown-subpath' });
  });

  test('returns undefined when no method+path pair matches', async () => {
    expect(await dispatch('DELETE', '/api/nope')).toBeNull();
  });

  test('array methods match HEAD on the manifest path', async () => {
    const matched = await dispatch('HEAD', '/api/manifest.webmanifest');
    expect(matched?.path).toBe('/api/manifest.webmanifest');
  });
});

describe('dispatchRoutes', () => {
  test('skips a matching route that returns null and continues', () => {
    const routes: ApiRoute[] = [
      {
        method: '*',
        path: '/api/example',
        handler: () => null,
      },
      {
        method: 'GET',
        path: '/api/example',
        handler: () => new Response('ok', { status: 200 }),
      },
    ];
    const req = new Request('http://localhost/api/example');
    const result = dispatchRoutes(req, '/api/example', routes, {
      server: {} as never,
      path: '/api/example',
    });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(200);
  });
});
