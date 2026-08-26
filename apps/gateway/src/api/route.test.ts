import { describe, expect, test } from 'bun:test';
import { type ApiRoute, dispatchRoutes, matchPath, matchRoute, methodMatches } from './route';

function handler(): Response {
  return new Response(null, { status: 204 });
}

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

describe('matchRoute priority', () => {
  const routes: ApiRoute[] = [
    { method: 'GET', path: '/api/devices', handler },
    { method: 'PUT', path: '/api/devices/order', handler },
    { method: 'GET', path: '/api/devices/:id', handler },
    { method: 'POST', path: '/api/devices/:id/test-connection', handler },
    { method: '*', path: '/api/devices/*', handler },
    { method: ['GET', 'HEAD'], path: '/api/manifest.webmanifest', handler },
  ];

  test('fixed /api/devices/order wins over /api/devices/:id', () => {
    const matched = matchRoute('PUT', '/api/devices/order', routes);
    expect(matched?.route.path).toBe('/api/devices/order');
    expect(matched?.params).toEqual({});
  });

  test('GET /api/devices/order does not take the PUT order route and matches :id', () => {
    const matched = matchRoute('GET', '/api/devices/order', routes);
    expect(matched?.route.path).toBe('/api/devices/:id');
    expect(matched?.params).toEqual({ id: 'order' });
  });

  test('GET /api/devices/:id extracts the id', () => {
    const matched = matchRoute('GET', '/api/devices/dev-1', routes);
    expect(matched?.route.path).toBe('/api/devices/:id');
    expect(matched?.params).toEqual({ id: 'dev-1' });
  });

  test('list route is preferred over :id for the collection path', () => {
    const matched = matchRoute('GET', '/api/devices', routes);
    expect(matched?.route.path).toBe('/api/devices');
  });

  test('later prefix route only matches leftover device paths', () => {
    const matched = matchRoute('GET', '/api/devices/dev-1/tree-order', routes);
    expect(matched?.route.path).toBe('/api/devices/*');
    expect(matched?.params).toEqual({ '*': 'dev-1/tree-order' });
  });

  test('returns null when no method+path pair matches', () => {
    expect(matchRoute('DELETE', '/api/nope', routes)).toBeNull();
  });

  test('array methods match HEAD on the manifest path', () => {
    const matched = matchRoute('HEAD', '/api/manifest.webmanifest', routes);
    expect(matched?.route.path).toBe('/api/manifest.webmanifest');
  });
});

describe('dispatchRoutes', () => {
  test('skips a matching route that returns null and continues', () => {
    const routes: ApiRoute[] = [
      {
        method: '*',
        path: '/api/capabilities',
        handler: () => null,
      },
      {
        method: 'GET',
        path: '/api/capabilities',
        handler: () => new Response('ok', { status: 200 }),
      },
    ];
    const req = new Request('http://localhost/api/capabilities');
    const result = dispatchRoutes(req, '/api/capabilities', routes, {
      server: {} as never,
      path: '/api/capabilities',
    });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(200);
  });
});
