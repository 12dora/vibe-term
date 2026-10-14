import { describe, expect, test } from 'bun:test';
import type { AccessTokenScope } from '@vibeterm/shared';
import { tokenScopeAllows } from './token-scope';

const allow = (method: string, path: string, scopes: AccessTokenScope[]) =>
  tokenScopeAllows(method, path, scopes);

describe('tokenScopeAllows', () => {
  test('base read surface is allowed for every scope set, even an empty one', () => {
    for (const scopes of [[], ['exec'], ['files'], ['forward']] as AccessTokenScope[][]) {
      expect(allow('GET', '/api/auth/mode', scopes)).toBe(true);
      expect(allow('GET', '/api/devices', scopes)).toBe(true);
      expect(allow('GET', '/api/mesh/nodes', scopes)).toBe(true);
    }
    expect(allow('POST', '/api/devices', ['exec'])).toBe(false);
    expect(allow('DELETE', '/api/mesh/nodes', ['exec', 'files', 'forward'])).toBe(false);
  });

  test('exec scope opens POST /api/exec and the exec websocket only', () => {
    expect(allow('POST', '/api/exec', ['exec'])).toBe(true);
    expect(allow('GET', '/api/exec/ws', ['exec'])).toBe(true);
    expect(allow('GET', '/api/exec', ['exec'])).toBe(false);
    expect(allow('POST', '/api/exec/ws', ['exec'])).toBe(false);
    expect(allow('POST', '/api/exec', ['files', 'forward'])).toBe(false);
    expect(allow('GET', '/api/exec/ws', ['files'])).toBe(false);
  });

  test('files scope opens the /api/files/ prefix, but not root configuration writes', () => {
    for (const path of [
      '/api/files/list',
      '/api/files/download',
      '/api/files/download/prepare',
      '/api/files/upload/init',
      '/api/files/upload/abc/commit',
      '/api/files/mkdir',
      '/api/files/delete',
      '/api/files/move',
      '/api/files/archive/prepare',
    ]) {
      expect(allow('POST', path, ['files'])).toBe(true);
      expect(allow('POST', path, ['exec', 'forward'])).toBe(false);
    }
    expect(allow('GET', '/api/files/roots', ['files'])).toBe(true);
    expect(allow('POST', '/api/files/roots', ['files'])).toBe(false);
    expect(allow('DELETE', '/api/files/roots/abc', ['files'])).toBe(false);
    expect(allow('GET', '/api/files', ['files'])).toBe(false);
    expect(allow('GET', '/api/filesystem/x', ['files'])).toBe(false);
  });

  test('forward scope opens /api/portmap and below', () => {
    expect(allow('GET', '/api/portmap', ['forward'])).toBe(true);
    expect(allow('POST', '/api/portmap/probe', ['forward'])).toBe(true);
    expect(allow('GET', '/api/portmap/exports', ['forward'])).toBe(true);
    expect(allow('GET', '/api/portmap', ['exec', 'files'])).toBe(false);
    expect(allow('GET', '/api/portmapper', ['forward'])).toBe(false);
  });

  test('everything else is denied for every scope', () => {
    const all: AccessTokenScope[] = ['exec', 'files', 'forward'];
    for (const [method, path] of [
      ['GET', '/api/auth/tokens'],
      ['POST', '/api/auth/tokens'],
      ['DELETE', '/api/auth/tokens/x'],
      ['POST', '/api/auth/logout'],
      ['GET', '/api/auth/keylog'],
      ['POST', '/api/auth/local'],
      ['GET', '/api/settings/site'],
      ['GET', '/ws'],
      ['GET', '/n/self/api/devices'],
      ['GET', '/api/auth/mode/'],
    ] as const) {
      expect(allow(method, path, all)).toBe(false);
    }
  });

  test('method matching is case-insensitive', () => {
    expect(allow('post', '/api/exec', ['exec'])).toBe(true);
  });
});
