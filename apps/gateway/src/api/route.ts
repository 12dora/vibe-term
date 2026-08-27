import type { Server } from 'bun';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
export type RouteMethod = HttpMethod | readonly HttpMethod[] | '*';

export type SystemApiHandler = (
  req: Request,
  path: string
) => Response | Promise<Response> | undefined;

export interface ApiRouteContext {
  server: Server<unknown>;
  path: string;
  systemApiHandler?: SystemApiHandler;
}

type ExtractParam<S extends string> = S extends `:${infer P}` ? P : never;
type SplitPath<P extends string> = P extends `${infer A}/${infer B}` ? A | SplitPath<B> : P;
type ParamKeys<P extends string> = ExtractParam<SplitPath<P>>;

export type PathParams<P extends string> = string extends P
  ? Record<string, string>
  : P extends `${string}*`
    ? { '*': string }
    : [ParamKeys<P>] extends [never]
      ? Record<string, never>
      : { [K in ParamKeys<P>]: string };

export type ApiRouteHandler<P extends string = string> = (
  req: Request,
  params: PathParams<P>,
  ctx: ApiRouteContext
) => Response | Promise<Response> | undefined | null;

export interface ApiRoute<P extends string = string> {
  method: RouteMethod;
  path: P;
  handler: ApiRouteHandler<P>;
}

export function route<P extends string>(def: ApiRoute<P>): ApiRoute<P> {
  return def;
}

export function methodMatches(method: string, expected: RouteMethod): boolean {
  if (expected === '*') return true;
  if (typeof expected === 'string') return method === expected;
  return expected.includes(method as HttpMethod);
}

export function matchPath(pathname: string, pattern: string): Record<string, string> | null {
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    if (!pathname.startsWith(prefix)) return null;
    return { '*': pathname.slice(prefix.length) };
  }

  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const expected = patternParts[i];
    const actual = pathParts[i];
    if (expected.startsWith(':')) {
      if (!actual) return null;
      params[expected.slice(1)] = actual;
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

export function dispatchRoutes(
  req: Request,
  pathname: string,
  routes: readonly ApiRoute[],
  ctx: ApiRouteContext
): Response | Promise<Response> | undefined {
  for (const candidate of routes) {
    if (!methodMatches(req.method, candidate.method)) continue;
    const params = matchPath(pathname, candidate.path);
    if (!params) continue;
    const result = candidate.handler(req, params, ctx);
    if (result) return result;
  }
  return undefined;
}
