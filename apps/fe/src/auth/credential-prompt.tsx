// 「用密码或 passkey 确认本次操作」的唯一入口（设计 §2「用户密钥」）。
//
// 持久记录只能由根钥或 passkey 断言签名，`sk_sess` 一概不参与——所以每个写 key-log 的动作
// 都要当场做一次凭据交互。本模块把这次交互收敛成一个对话框 + 一个 hook：
//   - `request()`：拿一个 `RecordSigner` 并放进 5 分钟复用窗口（窗口负责清零根钥 seed）；
//   - `withSigner()`：作用域式，回调返回即清零（根钥路径直接复用 `withRootSigner`）。
//
// passkey 选项只在「后端说本环境能用 passkey」且「当前 origin 确实有已注册凭证」时出现：
// 拿别的 origin 的凭证发起仪式必然 `NotAllowedError`，给用户一个注定失败的按钮比不给更糟。

import type { AuthApi, AuthKdfParamsJson, PasskeySummary } from '@tmex/api-client/auth/index';
import { WebAuthnError, defaultAuthApi } from '@tmex/api-client/auth/index';
import { bytesEqual, decodeBase64url } from '@tmex/shared/auth';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { Fingerprint, KeyRound, Loader2 } from 'lucide-react';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  passkeysForOrigin,
  rootSignerFromPassword,
  withRootSigner,
} from './account-security-actions';
import type { RecordSigner } from './key-log-actions';

/** 刚做完密码 / passkey 交互后的免二次输入窗口（设计 §2 步骤 3）。 */
export const SIGNER_REUSE_WINDOW_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// 5 分钟凭据复用（仅内存）
// ---------------------------------------------------------------------------

/** 复用窗口的归属令牌：谁存的谁才能清（多个对话框实例同时挂着时的唯一判据）。 */
export type SignerOwner = symbol;

let rememberedSigner: { signer: RecordSigner; until: number; owner: SignerOwner | null } | null =
  null;
let rememberedTimer: ReturnType<typeof setTimeout> | null = null;
/** 正在被使用（签一条记录）的签名者：租约期内不清零，`leases` 记引用计数。 */
const leases = new Map<RecordSigner, number>();
/** 租约期内被要求清零的签名者：等租约还清再动手。 */
const deferredWipes = new Set<RecordSigner>();

/** 根钥签名者的 seed 是根私钥：丢引用不够，必须显式清零。 */
export function wipeSigner(signer: RecordSigner | null | undefined): void {
  if (signer?.kind === 'root') signer.rootKey.seed.fill(0);
}

function dropRemembered(): void {
  if (rememberedTimer !== null) {
    clearTimeout(rememberedTimer);
    rememberedTimer = null;
  }
  const previous = rememberedSigner;
  rememberedSigner = null;
  if (!previous) return;
  // 有人正拿它签记录：现在清零会让签名用到半截的根钥，推迟到租约释放。
  if (leases.has(previous.signer)) deferredWipes.add(previous.signer);
  else wipeSigner(previous.signer);
}

/**
 * 占住一个签名者，直到记录构造完成。
 *
 * 复用窗口是模块级的，任何一个对话框实例卸载都会调 `forgetSigner()`；没有租约时，
 * 那次清零会把引擎正在用的根钥 seed 抹成 0，签出来的记录直接作废（见 R4 #5）。
 */
export function leaseSigner(signer: RecordSigner): () => void {
  leases.set(signer, (leases.get(signer) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const rest = (leases.get(signer) ?? 1) - 1;
    if (rest > 0) {
      leases.set(signer, rest);
      return;
    }
    leases.delete(signer);
    if (deferredWipes.delete(signer)) wipeSigner(signer);
  };
}

/**
 * 记住刚做完的密码 / passkey 交互，5 分钟内自动复用。
 * 到期由定时器主动清零，而不是等下一次 `takeRememberedSigner()`——否则根私钥副本会一直留在堆里。
 */
export function rememberSigner(signer: RecordSigner, now: number, owner?: SignerOwner): void {
  dropRemembered();
  rememberedSigner = { signer, until: now + SIGNER_REUSE_WINDOW_MS, owner: owner ?? null };
  rememberedTimer = setTimeout(() => {
    rememberedTimer = null;
    dropRemembered();
  }, SIGNER_REUSE_WINDOW_MS);
  // Node/Bun 下别让定时器吊住进程。
  (rememberedTimer as { unref?: () => void }).unref?.();
}

export function takeRememberedSigner(now: number): RecordSigner | null {
  if (!rememberedSigner) return null;
  if (rememberedSigner.until <= now) {
    dropRemembered();
    return null;
  }
  return rememberedSigner.signer;
}

/**
 * 复用窗口结束（用完 / 页面卸载 / 换用户）：立刻清零。
 *
 * 带 `owner` 时**只清自己存进去的那个**：设置页与侧滑面板各挂一个对话框实例，
 * 任一实例卸载都不该抹掉另一实例刚做完的认证（见 R4 #5）。
 */
export function forgetSigner(owner?: SignerOwner): void {
  if (owner && rememberedSigner?.owner !== owner) return;
  dropRemembered();
}

// ---------------------------------------------------------------------------
// 纯逻辑：可选凭据、由用户选择造签名者
// ---------------------------------------------------------------------------

export type CredentialPurpose = 'enroll' | 'admit' | 'revoke' | 'passkey' | 'totp';

export type CredentialChoice =
  | { kind: 'password'; password: string }
  | { kind: 'passkey'; credentialId: string };

/** 密码派生出的根公钥与服务端下发的不一致 = 密码打错了（或后端已 rotate）。 */
export class WrongPasswordError extends Error {
  readonly code = 'ROOT_KEY_MISMATCH';
  constructor() {
    super('derived root public key does not match the server root public key');
    this.name = 'WrongPasswordError';
  }
}

/**
 * 本次交互里可用的 passkey。
 *
 * `passkeyAvailable=false`（非 HTTPS / 无域名）时一律为空；否则按注册 origin 过滤，
 * 只留能在当前入口真正发起断言的那些。
 */
export function usablePasskeys(input: {
  passkeys?: PasskeySummary[] | null;
  passkeyAvailable?: boolean;
  origin?: string;
}): PasskeySummary[] {
  if (!input.passkeyAvailable) return [];
  const rows = input.passkeys ?? [];
  if (rows.length === 0) return [];
  return passkeysForOrigin(rows, input.origin);
}

/** 用户选择 → `RecordSigner`。根钥路径可选地对拍服务端根公钥，密码打错当场报错。 */
export async function signerFromChoice(
  choice: CredentialChoice,
  kdfParams: AuthKdfParamsJson,
  rootPublicKey?: Uint8Array | null
): Promise<RecordSigner> {
  if (choice.kind === 'passkey') {
    return { kind: 'passkey', credentialId: choice.credentialId };
  }
  const signer = await rootSignerFromPassword(choice.password, kdfParams);
  if (rootPublicKey && signer.kind === 'root') {
    if (!bytesEqual(signer.rootKey.publicKey, rootPublicKey)) {
      wipeSigner(signer);
      throw new WrongPasswordError();
    }
  }
  return signer;
}

/**
 * 作用域式使用：回调返回（或抛异常）后立刻清零根钥 seed。
 * 根钥路径直接复用 `withRootSigner`，passkey 路径没有需要清零的秘密。
 */
export async function runWithChoice<T>(
  choice: CredentialChoice,
  kdfParams: AuthKdfParamsJson,
  fn: (signer: RecordSigner) => Promise<T> | T,
  rootPublicKey?: Uint8Array | null
): Promise<T> {
  if (choice.kind === 'passkey') {
    return fn({ kind: 'passkey', credentialId: choice.credentialId });
  }
  return withRootSigner(choice.password, kdfParams, async (signer) => {
    if (rootPublicKey && signer.kind === 'root') {
      if (!bytesEqual(signer.rootKey.publicKey, rootPublicKey)) throw new WrongPasswordError();
    }
    return fn(signer);
  });
}

/** 这类错误是「用户输入 / 仪式」层面的：留在对话框里让用户重试，而不是把框关掉。 */
export function isRetryableCredentialError(error: unknown): boolean {
  if (error instanceof WrongPasswordError) return true;
  return error instanceof WebAuthnError && error.code === 'aborted';
}

/** `/api/auth/mode` 的 `rootPublicKey`（base64url，32 字节）；缺失或畸形返回 `null`。 */
export function decodeRootPublicKey(value: string | null | undefined): Uint8Array | null {
  if (!value) return null;
  try {
    const bytes = decodeBase64url(value);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// passkey 列表
// ---------------------------------------------------------------------------

/** 拉一次 `GET /api/auth/passkeys`。失败即视为「本入口没有可用 passkey」，只留密码路径。 */
export function usePasskeys(
  api: AuthApi = defaultAuthApi,
  options: { enabled?: boolean } = {}
): { passkeys: PasskeySummary[]; error: string | null; reload: () => void } {
  const enabled = options.enabled ?? true;
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((): (() => void) => {
    if (!enabled) return () => undefined;
    let cancelled = false;
    api
      .listPasskeys()
      .then((rows) => {
        if (cancelled) return;
        setPasskeys(rows);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPasskeys([]);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [api, enabled]);

  useEffect(() => load(), [load]);
  return { passkeys, error, reload: load };
}

// ---------------------------------------------------------------------------
// 对话框
// ---------------------------------------------------------------------------

export interface CredentialPromptDialogProps {
  purpose: CredentialPurpose;
  /** 已按 origin 过滤过的可用凭证；为空则只渲染密码路径。 */
  passkeys: PasskeySummary[];
  busy: boolean;
  error: string | null;
  onSubmit: (choice: CredentialChoice) => void;
  onCancel: () => void;
}

/**
 * 无 portal 的轻量遮罩：Radix/base-ui 的 Dialog 走 portal，在服务端静态渲染里什么都不输出，
 * 而本页的用例正是靠静态渲染断言「passkey 选项只在允许时出现」。
 */
export function CredentialPromptDialog({
  purpose,
  passkeys,
  busy,
  error,
  onSubmit,
  onCancel,
}: CredentialPromptDialogProps) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [credentialId, setCredentialId] = useState(passkeys[0]?.credential_id ?? '');

  const canUsePasskey = passkeys.length > 0;
  const selected = canUsePasskey
    ? (passkeys.find((row) => row.credential_id === credentialId) ?? passkeys[0])
    : null;

  return (
    <div
      className="tmex-fade fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="credential-prompt"
    >
      <div className="tmex-scale-in flex w-full max-w-sm flex-col gap-3 rounded-xl border border-border bg-background p-4 shadow-lg">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-semibold">{t('auth.credential.title')}</h2>
          <p className="text-xs text-muted-foreground" data-testid="credential-prompt-purpose">
            {t(`auth.credential.purpose.${purpose}`)}
          </p>
        </div>
        <p className="text-xs text-muted-foreground">{t('auth.credential.hint')}</p>

        <Input
          type="password"
          autoComplete="current-password"
          placeholder={t('auth.security.currentPassword')}
          value={password}
          data-testid="credential-prompt-password"
          onChange={(event) => setPassword(event.target.value)}
        />

        {/* 播报节点常驻：`empty:hidden` 会把它从可访问性树里摘掉，播报会时灵时不灵。
            sr-only 是 absolute 定位，空着也不占 flex gap；可见的报错块另外条件渲染。 */}
        <output className="sr-only" aria-live="polite">
          {error ? t(error, { defaultValue: error }) : ''}
        </output>
        {error ? (
          <p className="tmex-fade text-xs text-destructive" data-testid="credential-prompt-error">
            {t(error, { defaultValue: error })}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy || !password}
            onClick={() => onSubmit({ kind: 'password', password })}
            data-testid="credential-prompt-submit"
          >
            {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <KeyRound />}
            {t('auth.credential.usePassword')}
          </Button>
          {canUsePasskey && selected ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => onSubmit({ kind: 'passkey', credentialId: selected.credential_id })}
              data-testid="credential-prompt-passkey"
            >
              <Fingerprint />
              {t('auth.credential.usePasskey')}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onCancel}
            data-testid="credential-prompt-cancel"
          >
            {t('common.cancel')}
          </Button>
        </div>

        {canUsePasskey && passkeys.length > 1 ? (
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            {t('auth.credential.passkeySelect')}
            <select
              className="rounded-md border border-border bg-background p-1 text-xs"
              value={selected?.credential_id ?? ''}
              data-testid="credential-prompt-passkey-select"
              onChange={(event) => setCredentialId(event.target.value)}
            >
              {passkeys.map((row) => (
                <option key={row.credential_id} value={row.credential_id}>
                  {row.name || row.credential_id}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// hook
// ---------------------------------------------------------------------------

export interface CredentialPromptConfig {
  kdfParams: AuthKdfParamsJson;
  /** `/api/auth/mode` 下发的根公钥；给了就对拍，密码打错当场报错。 */
  rootPublicKey?: Uint8Array | null;
  passkeys?: PasskeySummary[] | null;
  passkeyAvailable?: boolean;
  origin?: string;
}

export interface CredentialPromptHandle {
  /**
   * 取一个签名者并放进 5 分钟复用窗口（窗口负责清零根钥 seed）。
   * `reuse` 为真且窗口里还有签名者时直接返回，不打扰用户。用户取消返回 `null`。
   */
  request(options?: { purpose?: CredentialPurpose; reuse?: boolean }): Promise<RecordSigner | null>;
  /** 作用域式：回调返回即清零，**不**进复用窗口。用户取消返回 `null`。 */
  withSigner<T>(
    fn: (signer: RecordSigner) => Promise<T> | T,
    options?: { purpose?: CredentialPurpose }
  ): Promise<T | null>;
  /** 立刻清零复用窗口。 */
  forget(): void;
  /** 挂在页面里的对话框；没有待确认的请求时为 `null`。 */
  dialog: React.ReactElement | null;
  /** 当前可用的 passkey（已按 origin 过滤）。 */
  passkeys: PasskeySummary[];
}

interface PendingPrompt {
  purpose: CredentialPurpose;
  consume: (choice: CredentialChoice) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/** 本实例的归属令牌：只清自己存进复用窗口的那个签名者。 */
function usePromptOwner(): SignerOwner {
  const ref = useRef<SignerOwner | null>(null);
  if (ref.current === null) ref.current = Symbol('credential-prompt');
  return ref.current;
}

/** 卸载：挂着的请求当取消处理，**本实例存的**根钥立刻清零（别人存的不碰）。 */
function usePromptTeardown(pendingRef: RefObject<PendingPrompt | null>, owner: SignerOwner): void {
  useEffect(
    () => () => {
      pendingRef.current?.resolve(null);
      pendingRef.current = null;
      forgetSigner(owner);
    },
    [pendingRef, owner]
  );
}

export function useCredentialPrompt(config: CredentialPromptConfig): CredentialPromptHandle {
  const [open, setOpen] = useState<CredentialPurpose | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<PendingPrompt | null>(null);
  const owner = usePromptOwner();
  usePromptTeardown(pendingRef, owner);

  const { kdfParams, rootPublicKey, passkeys, passkeyAvailable, origin } = config;
  const usable = useMemo(
    () => usablePasskeys({ passkeys, passkeyAvailable, origin }),
    [passkeys, passkeyAvailable, origin]
  );

  const ask = useCallback(
    <T,>(purpose: CredentialPurpose, consume: (choice: CredentialChoice) => Promise<T>) =>
      new Promise<T | null>((resolve, reject) => {
        // 上一个请求还没结果就又来一个：把旧的当成「取消」，否则它的 promise 永远挂着。
        pendingRef.current?.resolve(null);
        pendingRef.current = {
          purpose,
          consume: consume as (choice: CredentialChoice) => Promise<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject,
        };
        setError(null);
        setBusy(false);
        setOpen(purpose);
      }),
    []
  );

  const settle = useCallback((finish: (pending: PendingPrompt) => void) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setOpen(null);
    setBusy(false);
    setError(null);
    if (pending) finish(pending);
  }, []);

  const submit = useCallback(
    async (choice: CredentialChoice) => {
      const pending = pendingRef.current;
      if (!pending || busy) return;
      setBusy(true);
      setError(null);
      try {
        const value = await pending.consume(choice);
        settle((row) => row.resolve(value));
      } catch (err) {
        if (isRetryableCredentialError(err)) {
          // 密码打错 / 仪式被取消：留在框里，让用户直接重试。
          setError(credentialErrorText(err));
          setBusy(false);
          return;
        }
        settle((row) => row.reject(err));
      }
    },
    [busy, settle]
  );

  const cancel = useCallback(() => settle((pending) => pending.resolve(null)), [settle]);

  const request = useCallback(
    async (options: { purpose?: CredentialPurpose; reuse?: boolean } = {}) => {
      if (options.reuse) {
        const reused = takeRememberedSigner(Date.now());
        if (reused) return reused;
      }
      return ask(options.purpose ?? 'admit', async (choice) => {
        const signer = await signerFromChoice(choice, kdfParams, rootPublicKey);
        // 交给复用窗口托管：它负责到期 / 显式清零，调用方不必再管根钥 seed。
        rememberSigner(signer, Date.now(), owner);
        return signer;
      });
    },
    [ask, kdfParams, rootPublicKey, owner]
  );

  const withSigner = useCallback(
    <T,>(
      fn: (signer: RecordSigner) => Promise<T> | T,
      options: { purpose?: CredentialPurpose } = {}
    ) =>
      ask(options.purpose ?? 'revoke', (choice) =>
        runWithChoice(choice, kdfParams, fn, rootPublicKey)
      ),
    [ask, kdfParams, rootPublicKey]
  );

  const forget = useCallback(() => forgetSigner(owner), [owner]);

  return {
    request: request as CredentialPromptHandle['request'],
    withSigner: withSigner as CredentialPromptHandle['withSigner'],
    forget,
    passkeys: usable,
    dialog: open ? (
      <CredentialPromptDialog
        purpose={open}
        passkeys={usable}
        busy={busy}
        error={error}
        onSubmit={(choice) => void submit(choice)}
        onCancel={cancel}
      />
    ) : null,
  };
}

/** 对话框里的错误文案：能对上 i18n key 的返回 key，其余原样返回（对话框用 defaultValue 兜底）。 */
export function credentialErrorText(error: unknown): string {
  if (error instanceof WrongPasswordError) return 'auth.errors.ROOT_KEY_MISMATCH';
  if (error instanceof WebAuthnError) return 'auth.errors.PASSKEY_ABORTED';
  return error instanceof Error ? error.message : String(error);
}
