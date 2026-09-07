import { isIP } from 'node:net';
import { TlsApiError } from './errors';

const HOSTNAME_RE =
  /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validatePort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new TlsApiError('invalid_port', 400, 'tlsPort must be an integer in 1..65535');
  }
  return value;
}

export function validateBindHost(value: string): string {
  const host = value.trim();
  if (!host) throw new TlsApiError('invalid_port', 400, 'bindHost is required');
  return host;
}

export function validateSans(sans: string[]): string[] {
  if (!Array.isArray(sans) || sans.length < 1 || sans.length > 20) {
    throw new TlsApiError('invalid_sans', 400, 'sans must contain 1 to 20 hostnames or IPs');
  }
  const normalized = sans.map((item) => item.trim()).filter(Boolean);
  if (normalized.length !== sans.length || !normalized.every(isValidSan)) {
    throw new TlsApiError('invalid_sans', 400, 'each SAN must be a valid hostname or IP');
  }
  return normalized;
}

export function validateDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  if (!domain || domain.includes('*') || isIP(domain) !== 0 || !HOSTNAME_RE.test(domain)) {
    throw new TlsApiError('invalid_domain', 400, 'domain must be a hostname without wildcards');
  }
  return domain;
}

export function validateEmail(value: string): string {
  const email = value.trim();
  if (!EMAIL_RE.test(email)) throw new TlsApiError('invalid_email', 400, 'email is invalid');
  return email;
}

function isValidSan(value: string): boolean {
  return isIP(value) !== 0 || HOSTNAME_RE.test(value);
}
