import { redactSecrets } from './redact';

const BEARER = /bearer\s+[A-Za-z0-9._\-]+/gi;
const CF_TOKEN = /\b[A-Za-z0-9_\-]{40,}\b/g;

export function sanitizeAccessError(message: string): string {
  let out = message.replace(BEARER, 'Bearer ***');
  out = redactSecrets(out);
  out = out.replace(CF_TOKEN, '***');
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > 300) out = `${out.slice(0, 297)}...`;
  return out || 'Cloudflare API request failed';
}

export function teamIssuer(teamDomain: string): string {
  return `https://${teamDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
}

export function jwksUrlForTeam(teamDomain: string): string {
  return `${teamIssuer(teamDomain)}/cdn-cgi/access/certs`;
}
