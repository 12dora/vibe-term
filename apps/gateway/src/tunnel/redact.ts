const DASH_CF_QUERY_URL = /https:\/\/dash\.cloudflare\.com\/[^\s]*\?[^\s]*/gi;
const SECRET_KEY_RE =
  /^(?:pass(?:word)?|secret|token|api[-_]?key|authorization|cookie|session|jwt|bearer|credential)$/i;

export function redactSecrets(line: string): string {
  let out = line.replace(DASH_CF_QUERY_URL, 'https://dash.cloudflare.com/***');
  out = out.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s]+)@/g, '$1***@');
  out = out.replace(/https?:\/\/[^\s"'<>]+/gi, (url) =>
    url.replace(/([?&][^=&\s#]+)=([^&#\s]*)/g, '$1=***')
  );
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
  out = out.replace(/\bBasic\s+[A-Za-z0-9+/]+=*/gi, 'Basic ***');
  out = out.replace(/"([^"\\]+)"\s*:\s*"((?:\\.|[^"\\])*)"/g, (full, key: string) => {
    if (SECRET_KEY_RE.test(key)) return `"${key}":"***"`;
    return full;
  });
  out = out.replace(/([?&]?)([A-Za-z0-9_-]+)=([^\s&"'`]*)/g, (full, sep: string, key: string) => {
    if (SECRET_KEY_RE.test(key)) return `${sep}${key}=***`;
    return full;
  });
  return out.replace(/[A-Za-z0-9+/_-]{32,}={0,2}|\b[0-9a-fA-F]{32,}\b/g, '***');
}
