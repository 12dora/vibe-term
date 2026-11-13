export const CLIENT_IP_HEADERS = ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip'] as const;
export type ClientIpHeader = (typeof CLIENT_IP_HEADERS)[number];
export const DEFAULT_CLIENT_IP_HEADER: ClientIpHeader = 'x-forwarded-for';

export function parseClientIpHeader(raw: string | undefined): ClientIpHeader {
  const value = raw?.trim().toLowerCase();
  if (!value) return DEFAULT_CLIENT_IP_HEADER;
  const found = CLIENT_IP_HEADERS.find((name) => name === value);
  if (!found) {
    throw new Error(`VIBETERM_CLIENT_IP_HEADER must be one of ${CLIENT_IP_HEADERS.join(' | ')}`);
  }
  return found;
}
