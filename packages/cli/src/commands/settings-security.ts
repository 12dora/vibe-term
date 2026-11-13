import { SELF_NODE_ID } from '@vibeterm/api-client/node-url';
import {
  PASSKEY_REGISTER_HINT,
  changeAccountPassword,
  confirmTotpCode,
  decodeTotpSecret,
  disableTotp,
  enableTotp,
  generateTotpSecret,
  listPasskeys,
  removePasskey,
  totpPreview,
} from '../core/account-security';
import { flagBool, flagString } from '../core/args';
import { fetchAuthMode, requiresLogin } from '../core/auth';
import {
  type SubHandler,
  confirmOrYes,
  emit,
  readSecretField,
  rejectExtra,
  requireArg,
  sleep,
} from '../core/cmd';
import { UsageError } from '../core/errors';
import {
  DEFAULT_LOGIN_CONCURRENCY,
  DEFAULT_NODE_TIMEOUT_MS,
  type TargetOutcome,
  isNetworkLoginCode,
  reportLoginOutcomes,
} from '../core/login-fanout';
import { readAccountPassword } from '../core/nodes-keylog';
import { isInteractive, promptHidden } from '../core/prompt';
import { enabledFromFlags } from '../core/settings-body';
import { loginWithPassword } from './login';
import { jsonSelf, print } from './settings-http';

async function readNewPassword(ctx: Parameters<SubHandler>[0], flags: Parameters<SubHandler>[1]) {
  const fromField = await readSecretField(ctx, flags, {
    flag: 'new-password',
    envName: 'VIBETERM_NEW_PASSWORD',
  });
  if (fromField) return fromField;
  if (!isInteractive()) {
    throw new UsageError(
      'new password is required and stdin is not a terminal',
      'pass --new-password-stdin, --new-password-file, or VIBETERM_NEW_PASSWORD'
    );
  }
  const first = await promptHidden('New password: ');
  if (!first) throw new UsageError('new password is empty');
  const second = await promptHidden('Confirm new password: ');
  if (first !== second) throw new UsageError('passwords do not match');
  return first;
}

export const passwd: SubHandler = async (ctx, flags, positionals) => {
  rejectExtra(positionals, 0);
  const fullReset = flagBool(flags, 'full-reset');
  if (fullReset) {
    await confirmOrYes(
      flags,
      'full reset clears every passkey and authenticator and signs you out everywhere'
    );
  }
  const oldPassword = await readAccountPassword();
  const newPassword = await readNewPassword(ctx, flags);
  const result = await changeAccountPassword(ctx, { fullReset, oldPassword, newPassword });
  return reloginAfterPasswordChange(ctx, result, newPassword);
};

/** 单测替换 sleep / 间隔，避免真等 key-log 传播。 */
export const passwdReloginBackoff = {
  tries: 3,
  gapMs: 3_000,
  sleep: (ms: number) => sleep(ms),
};

function cliLang(): 'zh-CN' | 'en' {
  const raw = process.env.VIBETERM_CLI_LANG || process.env.LANG || '';
  const lower = raw.trim().toLowerCase().replaceAll('_', '-');
  if (lower === 'zh' || lower === 'cn' || lower.startsWith('zh-cn')) return 'zh-CN';
  return 'en';
}

/** keep 改密后的级联说明；语言跟随 `VIBETERM_CLI_LANG` / `LANG`。 */
export function passwdCascadeNotice(): string {
  return cliLang() === 'zh-CN'
    ? '已撤销全部登录会话、访问令牌、终端分享与窗格授权'
    : 'Revoked all sign-in sessions, access tokens, terminal shares, and pane grants';
}

function rosterReloginPending(outcomes: readonly TargetOutcome[]): TargetOutcome[] {
  return outcomes.filter((row) => !row.ok && row.node !== 'self' && !isNetworkLoginCode(row.code));
}

/** 改密会吊销全部会话（含本 CLI 的）：用新口令把入口与其余节点重新登录一遍。 */
async function reloginAfterPasswordChange(
  ctx: Parameters<SubHandler>[0],
  result: unknown,
  password: string
): Promise<number | undefined> {
  const notice = passwdCascadeNotice();
  let relogin: TargetOutcome[] = [];
  let code: number | undefined;
  try {
    const mode = await fetchAuthMode(ctx.http, SELF_NODE_ID);
    if (!mode || !requiresLogin(mode)) {
      emitPasswdResult(ctx, result, [], notice);
      return undefined;
    }
    for (let attempt = 1; attempt <= passwdReloginBackoff.tries; attempt += 1) {
      code = await loginWithPassword(ctx, mode, {
        password,
        nodeRef: null,
        timeoutMs: DEFAULT_NODE_TIMEOUT_MS,
        concurrency: DEFAULT_LOGIN_CONCURRENCY,
        report: (outcomes) => {
          relogin = outcomes;
        },
      });
      const pending = rosterReloginPending(relogin);
      if (pending.length === 0) break;
      if (attempt >= passwdReloginBackoff.tries) {
        ctx.out.warn(
          `password changed, but ${pending.length} node(s) rejected the new session; run \`vibeterm login\``
        );
        break;
      }
      ctx.out.warn(
        `roster login pending on ${pending.length} node(s); retrying after key-log sync`
      );
      await passwdReloginBackoff.sleep(passwdReloginBackoff.gapMs);
    }
  } catch (error) {
    emitPasswdResult(ctx, result, relogin, notice);
    const reason = error instanceof Error ? error.message : String(error);
    ctx.out.warn(`password changed, but signing in again failed: ${reason}`);
    ctx.out.warn('  run `vibeterm login` with the new password');
    return 1;
  }
  emitPasswdResult(ctx, result, relogin, notice);
  return code;
}

function emitPasswdResult(
  ctx: Parameters<SubHandler>[0],
  result: unknown,
  relogin: TargetOutcome[],
  notice: string
): void {
  emit(ctx, { ...(result as Record<string, unknown>), relogin, cascadeNotice: notice }, () => {
    ctx.out.info(notice);
    ctx.out.data(result);
    if (relogin.length > 0) reportLoginOutcomes(ctx, relogin);
  });
}

function totpSecretFromFlags(flags: Parameters<SubHandler>[1]): Uint8Array {
  const raw = flagString(flags, 'totp-secret') ?? process.env.VIBETERM_TOTP_SECRET;
  return raw ? decodeTotpSecret(raw) : generateTotpSecret();
}

function sayTotpSecret(ctx: Parameters<SubHandler>[0], line: string): void {
  if (ctx.globals.json) ctx.out.warn(line);
  else ctx.out.info(line);
}

export const totp: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'enable|disable');
  rejectExtra(positionals, 1);
  if (action === 'disable') {
    await confirmOrYes(flags, 'disable TOTP two-factor authentication');
    const result = await disableTotp(ctx, await readAccountPassword());
    print(ctx, result);
    return;
  }
  if (action !== 'enable') {
    throw new UsageError(`unknown totp action: ${action}`, 'use enable|disable');
  }
  const secret = totpSecretFromFlags(flags);
  try {
    const preview = await totpPreview(ctx, secret);
    sayTotpSecret(ctx, `Secret (base32): ${preview.secretBase32}`);
    sayTotpSecret(ctx, preview.otpauthUri);
    const code = await confirmTotpCode({
      secret,
      preset: flagString(flags, 'code') || process.env.VIBETERM_TOTP || null,
      interactive: isInteractive(),
      secretBase32: preview.secretBase32,
      prompt: () => promptHidden('TOTP code: '),
      warn: (message) => ctx.out.warn(message),
    });
    const password = await readAccountPassword();
    const outcome = await enableTotp(ctx, { password, secret, code });
    emit(ctx, outcome, () => ctx.out.line('TOTP enabled'));
  } finally {
    secret.fill(0);
  }
};

export const passkey: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'ls|rm');
  if (action === 'ls') {
    rejectExtra(positionals, 1);
    const passkeys = await listPasskeys(ctx);
    emit(ctx, { passkeys, hint: PASSKEY_REGISTER_HINT }, () => {
      ctx.out.info(PASSKEY_REGISTER_HINT);
      ctx.out.table(passkeys, [
        { header: 'ID', value: (row) => row.credential_id },
        { header: 'NAME', value: (row) => row.name ?? '-' },
        { header: 'ORIGIN', value: (row) => row.origin },
        { header: 'HERE', value: (row) => (row.usableHere === false ? 'no' : 'yes') },
      ]);
    });
    return;
  }
  if (action === 'rm') {
    const id = requireArg(positionals, 1, 'credential id');
    rejectExtra(positionals, 2);
    await confirmOrYes(flags, `delete passkey ${id}`);
    const result = await removePasskey(ctx, id, await readAccountPassword());
    print(ctx, result);
    return;
  }
  throw new UsageError(`unknown passkey action: ${action}`, 'use ls|rm');
};

export const localAuth: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'bootstrap|set');
  if (action === 'bootstrap') {
    rejectExtra(positionals, 1);
    const username = flagString(flags, 'user');
    if (!username) {
      throw new UsageError('local-auth bootstrap requires --user <username>');
    }
    const password = await readSecretField(ctx, flags, {
      flag: 'password',
      envName: 'VIBETERM_PASSWORD',
      required: true,
      prompt: 'Password: ',
    });
    print(ctx, await jsonSelf(ctx, 'POST', '/api/auth/local/bootstrap', { username, password }));
    return;
  }
  if (action === 'set') {
    print(
      ctx,
      await jsonSelf(ctx, 'POST', '/api/auth/local', {
        enabled: enabledFromFlags(flags, positionals[1]),
      })
    );
    return;
  }
  throw new UsageError(`unknown local-auth action: ${action}`, 'use bootstrap|set');
};
