import { isLoopbackClientIp, parseIpLiteral } from './address-class';
import { getMeshRequestContext } from './mesh-deps';

export type ClientIpInput = {
  socketIp?: string | null;
  headers: Headers;
  trustProxy: boolean;
};

export function resolveClientIp(input: ClientIpInput): string | undefined {
  const socket = trimOrUndef(input.socketIp);
  if (!input.trustProxy) return socket;
  return pickForwardedClientIp(input.headers) ?? socket;
}

export function isRequestLoopback(input: ClientIpInput): boolean {
  // Cloudflare 才会设置 CF-Connecting-IP；直连 localhost 不会带。只要出现即视为远端，
  // 与是否信任代理无关——否则代理保留的 `127.0.0.1` / 非法值会在信任模式下重新打开本机 bootstrap。
  if (headerValue(input.headers, 'cf-connecting-ip')) return false;
  return isLoopbackClientIp(resolveClientIp(input));
}

export function clientIpFromRequest(req: Request): string | undefined {
  return resolveClientIp(inputFromRequest(req));
}

export function requestIsLoopback(req: Request): boolean {
  return isRequestLoopback(inputFromRequest(req));
}

function inputFromRequest(req: Request): ClientIpInput {
  const ctx = getMeshRequestContext(req);
  return {
    socketIp: ctx.clientIp,
    headers: req.headers,
    trustProxy: ctx.trustProxy === true,
  };
}

function pickForwardedClientIp(headers: Headers): string | undefined {
  const cf = parseIpLiteral(headerValue(headers, 'cf-connecting-ip'));
  if (cf) return cf;
  const real = parseIpLiteral(headerValue(headers, 'x-real-ip'));
  if (real) return real;
  return parseIpLiteral(lastForwardedFor(headers.get('x-forwarded-for')));
}

function lastForwardedFor(value: string | null): string | undefined {
  if (!value) return undefined;
  const parts = value.split(',');
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const trimmed = parts[i]?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function headerValue(headers: Headers, name: string): string | undefined {
  return trimOrUndef(headers.get(name));
}

function trimOrUndef(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
