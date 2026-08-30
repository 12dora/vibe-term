const DASH_CF_QUERY_URL = /https:\/\/dash\.cloudflare\.com\/[^\s]*\?[^\s]*/gi;
const URL_WITH_AUD_OR_TOKEN = /https?:\/\/[^\s]*[?&](?:token|aud)=[^\s]*/gi;

export function redactSecrets(line: string): string {
  let out = line.replace(DASH_CF_QUERY_URL, 'https://dash.cloudflare.com/***');
  out = out.replace(URL_WITH_AUD_OR_TOKEN, (url) =>
    url.replace(/([?&](?:token|aud)=)[^&\s]*/gi, '$1***')
  );
  return out.replace(/[A-Za-z0-9+/]{32,}={0,2}|\b[0-9a-fA-F]{32,}\b/g, '***');
}
