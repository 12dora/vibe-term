function unwrapIpv6Host(host: string): string {
  if (host.startsWith('[') && host.endsWith(']') && host.includes(':')) {
    return host.slice(1, -1);
  }
  return host;
}

export function rewriteWildcardBindHost(host: string): string {
  const unwrapped = unwrapIpv6Host(host);
  if (unwrapped === '0.0.0.0') return '127.0.0.1';
  if (unwrapped === '::') return '::1';
  return host;
}

export function formatHttpEndpoint(host: string, port: number | string, path = ''): string {
  const unwrapped = unwrapIpv6Host(host);
  const authority = unwrapped.includes(':') ? `[${unwrapped}]:${port}` : `${unwrapped}:${port}`;
  const suffix = path === '' || path.startsWith('/') ? path : `/${path}`;
  return `http://${authority}${suffix}`;
}
