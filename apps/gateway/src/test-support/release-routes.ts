import { afterEach, beforeEach, spyOn } from 'bun:test';
import {
  RELEASE_LATEST_URL,
  releaseChangelogUrl,
  releaseSumsUrl,
  releaseTarballName,
} from '@vibeterm/shared';
import { resetLatestReleaseCache } from '../system/update-check';

export const MIN = 60_000;
export const LAST_MODIFIED = 'Sat, 01 Aug 2026 12:00:00 GMT';
export const LAST_MODIFIED_ISO = '2026-08-01T12:00:00.000Z';

const originalFetch = globalThis.fetch;
const CLOCK_START = 1_800_000_000_000;

/** 注册假时钟（Date.now）与 fetch/缓存的还原钩子；返回推进时间的函数。 */
export function useReleaseTestEnv(): { advance: (ms: number) => void; now: () => number } {
  let now = CLOCK_START;
  let clock: { mockRestore(): void } | null = null;
  beforeEach(() => {
    now = CLOCK_START;
    clock = spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    clock?.mockRestore();
    globalThis.fetch = originalFetch;
    resetLatestReleaseCache();
  });
  return {
    advance: (ms) => {
      now += ms;
    },
    now: () => now,
  };
}

export interface Captured {
  url: string;
  redirect: RequestRedirect | undefined;
  userAgent: string | null;
  hasSignal: boolean;
}

export type Route = () => Response | Promise<Response>;

export const captures: Captured[] = [];

export function mockRoutes(routes: Record<string, Route>): void {
  captures.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    captures.push({
      url,
      redirect: init?.redirect,
      userAgent: new Headers(init?.headers).get('user-agent'),
      hasSignal: init?.signal != null,
    });
    const route = routes[url];
    return route ? await route() : new Response('Not Found', { status: 404 });
  }) as typeof fetch;
}

export function hits(url: string): number {
  return captures.filter((c) => c.url === url).length;
}

export function tagLocation(version: string): string {
  return `https://github.com/12dora/vibe-term/releases/tag/v${version}`;
}

export function redirectTo(location: string): Route {
  return () => new Response(null, { status: 302, headers: { location } });
}

export function sumsBody(version: string, names: string[] = [releaseTarballName(version)]): string {
  return names.map((name) => `${'a'.repeat(64)}  ${name}\n`).join('');
}

export function sumsRoute(version: string, names?: string[]): Route {
  return () =>
    new Response(sumsBody(version, names), {
      status: 200,
      headers: { 'last-modified': LAST_MODIFIED },
    });
}

export function text(status: number, body: string, headers?: Record<string, string>): Route {
  return () => new Response(body, { status, headers });
}

export function releaseRoutes(
  version: string,
  changelog: string | null = 'notes'
): Record<string, Route> {
  return {
    [RELEASE_LATEST_URL]: redirectTo(tagLocation(version)),
    [releaseSumsUrl(version)]: sumsRoute(version),
    [releaseChangelogUrl(version)]:
      changelog === null ? text(404, 'Not Found') : text(200, changelog),
  };
}
