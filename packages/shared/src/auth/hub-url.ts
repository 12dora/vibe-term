export function canonicalHubUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid hub url: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`invalid hub url: ${raw}`);
  }
  if (!url.hostname) {
    throw new Error(`invalid hub url: ${raw}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('invalid hub url: credentials are not allowed');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('invalid hub url: query and fragment are not allowed');
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  const defaultPort = scheme === 'https' ? '443' : '80';
  const port = url.port && url.port !== defaultPort ? `:${url.port}` : '';
  const path = url.pathname.replace(/\/+$/, '');
  return `${scheme}://${host}${port}${path}`;
}
