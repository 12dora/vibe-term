export const ACME_RENEW_LEAD_MS = 30 * 24 * 60 * 60 * 1000;
export const RENEWAL_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const RENEWAL_BACKOFF_MIN_MS = 60 * 60 * 1000;
export const RENEWAL_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

export function acmeDirectoryUrl(staging: boolean): string {
  return `https://${staging ? 'acme-staging-v02' : 'acme-v02'}.api.letsencrypt.org/directory`;
}
