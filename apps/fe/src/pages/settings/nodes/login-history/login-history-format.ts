// 登录历史各列的文案：类型、方式、失败原因、入口节点、时间。

import { formatRelative } from '@/lib/format-relative';
import type { LoginRecord } from '@vibeterm/shared';

type Translate = (key: string, options?: Record<string, unknown>) => string;

const NS = 'settings.loginHistory';

export function clientText(t: Translate, client: LoginRecord['client'] | null | undefined): string {
  if (client === 'web') return t(`${NS}.client.web`);
  if (client === 'cli') return t(`${NS}.client.cli`);
  return t(`${NS}.client.unknown`);
}

/** 主凭证 + 二次验证合成一句；免二次验证（本机 / 局域网）单独点出来。 */
export function methodText(t: Translate, record: Pick<LoginRecord, 'method' | 'second'>): string {
  if (record.method === 'passkey') return t(`${NS}.method.passkey`);
  if (record.method !== 'root') return '—';
  switch (record.second) {
    case 'totp':
      return t(`${NS}.method.passwordTotp`);
    case 'passkey':
      return t(`${NS}.method.passwordPasskey`);
    case 'waived':
      return t(`${NS}.method.passwordWaived`);
    default:
      return t(`${NS}.method.password`);
  }
}

/** 失败原因：先认登录历史专用的几句，再退到通用错误表，都没有才显示原码。 */
export function reasonText(t: Translate, code: string | null | undefined): string {
  if (!code) return t(`${NS}.reason.unknown`);
  return t(`${NS}.reason.${code}`, {
    defaultValue: t(`auth.errors.${code}`, { defaultValue: code }),
  });
}

export function accountText(record: Pick<LoginRecord, 'username' | 'uid'>): string {
  return record.username || record.uid || '—';
}

/** 后台登录经由的入口节点名；认不出的节点给编号前 8 位。 */
export function entryNodeText(
  viaNodeId: string | null | undefined,
  names: ReadonlyMap<string, string>
): string | null {
  if (!viaNodeId) return null;
  return names.get(viaNodeId) ?? viaNodeId.slice(0, 8);
}

export function relativeTimeText(t: Translate, at: number, now: number): string {
  return formatRelative(t, at, now, 'settings.share.time') ?? t('settings.share.time.justNow');
}

export function absoluteTimeText(at: number): string {
  return new Date(at).toLocaleString();
}
