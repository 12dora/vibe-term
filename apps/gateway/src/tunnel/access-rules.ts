import type { TunnelAccessPolicyRule } from '@tmex/shared';
import { TunnelError } from './errors';
import { normalizeTunnelHostname } from './hostname';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseAccessRules(raw: unknown): TunnelAccessPolicyRule[] {
  if (!Array.isArray(raw)) {
    throw new TunnelError('invalid_request', 'rules must be an array');
  }
  return validateAccessRules(raw as TunnelAccessPolicyRule[]);
}

export function validateAccessRules(rules: TunnelAccessPolicyRule[]): TunnelAccessPolicyRule[] {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new TunnelError('invalid_request', 'at least one Access policy rule is required');
  }
  return rules.map((rule, index) => {
    if (!rule || (rule.kind !== 'email' && rule.kind !== 'email_domain')) {
      throw new TunnelError('invalid_request', `rules[${index}] has an invalid kind`);
    }
    const value = rule.value.trim().toLowerCase();
    if (rule.kind === 'email') {
      if (!EMAIL_RE.test(value)) {
        throw new TunnelError('invalid_request', `rules[${index}] is not a valid email`);
      }
      return { kind: 'email', value };
    }
    if (value.startsWith('@') || !normalizeTunnelHostname(value)) {
      throw new TunnelError('invalid_request', `rules[${index}] is not a valid email domain`);
    }
    return { kind: 'email_domain', value };
  });
}

export function parseAccessRulesJson(raw: string | null | undefined): TunnelAccessPolicyRule[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const rec = item as { kind?: unknown; value?: unknown };
      if ((rec.kind === 'email' || rec.kind === 'email_domain') && typeof rec.value === 'string') {
        return [{ kind: rec.kind, value: rec.value }];
      }
      return [];
    });
  } catch {
    return [];
  }
}

export function toCloudflareInclude(
  rules: TunnelAccessPolicyRule[]
): Array<{ email: { email: string } } | { email_domain: { domain: string } }> {
  return rules.map((rule) =>
    rule.kind === 'email'
      ? { email: { email: rule.value } }
      : { email_domain: { domain: rule.value } }
  );
}

export function fromCloudflareInclude(include: unknown): TunnelAccessPolicyRule[] {
  if (!Array.isArray(include)) return [];
  const out: TunnelAccessPolicyRule[] = [];
  for (const item of include) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (rec.email && typeof rec.email === 'object' && rec.email) {
      const email = (rec.email as { email?: unknown }).email;
      if (typeof email === 'string' && email.trim()) {
        out.push({ kind: 'email', value: email.trim().toLowerCase() });
      }
    } else if (rec.email_domain && typeof rec.email_domain === 'object' && rec.email_domain) {
      const domain = (rec.email_domain as { domain?: unknown }).domain;
      if (typeof domain === 'string' && domain.trim()) {
        out.push({ kind: 'email_domain', value: domain.trim().toLowerCase() });
      }
    }
  }
  return out;
}
