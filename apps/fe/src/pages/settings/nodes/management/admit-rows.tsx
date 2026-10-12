// 待确认行与加入结果行。阶段文案与结果块（`AdmitOutcome`）由设置页的节点管理区块和
// 「接入更多设备」面板共用，两处说的是同一句话。

import { type PasskeyTwiceContext, PasskeyTwiceHint } from '@/auth/passkey-twice-hint';
import { dismissAdmitProgress } from '@/node/admit-progress';
import type { PendingEnrollment } from '@/node/enrollment';
import type { AdmitProgress, EnrollmentEngineState } from '@/node/enrollment-engine-state';
import { Button } from '@vibeterm/ui/button';
import { Check, KeyRound, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { relayErrorText } from '../relay/use-relay-actions';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 两步加入（中继模式）正在跑的那一步；单步加入不标步骤。 */
export function admitStepLabel(t: Translate, progress: AdmitProgress | undefined): string | null {
  if (progress?.steps !== 2) return null;
  if (progress.phase === 'admitting') return t('nodes.enrollment.step.admit');
  if (progress.phase === 'distributing') return t('nodes.enrollment.step.memberKey');
  return null;
}

/** 确认失败的行内提示：错误码没有对应文案时退回通用的那一句。 */
export function admitFailureText(t: Translate, key: string): string {
  return t(key, { defaultValue: t('nodes.enrollment.admitFailed') });
}

function outcomeText(t: Translate, progress: AdmitProgress, doneText: string): string {
  if (progress.phase === 'done') return doneText;
  if (progress.phase === 'keyPending') return t('nodes.enrollment.memberKeyPending');
  if (progress.phase === 'expired') return t('nodes.enrollment.expired');
  return admitStepLabel(t, progress) ?? t('nodes.enrollment.confirmPending');
}

/** 一条加入的进度 / 结果：进行中的步骤、已加入、成员密钥待补发（带补发按钮）、已过期。 */
export function AdmitOutcome({
  id,
  progress,
  doneText,
  testId,
  onResendKey,
  onDismiss,
}: {
  id: string;
  progress: AdmitProgress;
  /** 「已加入」那一句：设置页说节点，面板说新机器。 */
  doneText: string;
  testId: string;
  onResendKey: (enrollmentId: string) => void;
  /** 给了就在结果旁放一个关闭按钮（进行中不给关）。 */
  onDismiss?: (enrollmentId: string) => void;
}) {
  const { t } = useTranslation();
  const { phase } = progress;
  const running = phase === 'admitting' || phase === 'distributing';
  const keyError = phase === 'keyPending' ? progress.keyError : undefined;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 text-xs"
      data-testid={testId}
      data-phase={phase}
    >
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
        {/* polite：1/2 → 2/2 → 结果逐句播报，不打断读屏。 */}
        <output className="flex min-w-0 items-center gap-1.5">
          {running && (
            <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
          )}
          {phase === 'done' && <Check className="size-3.5 shrink-0" />}
          <span>{outcomeText(t, progress, doneText)}</span>
          {progress.name && (
            <span className="truncate font-mono text-muted-foreground">{progress.name}</span>
          )}
        </output>
        {keyError && (
          <span className="text-destructive" role="alert" data-testid={`${testId}-reason`}>
            {relayErrorText(t, keyError)}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {phase === 'keyPending' && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onResendKey(id)}
            data-testid={`${testId}-resend`}
          >
            <KeyRound />
            {t('relay.tenant.metaKey.lagging.action')}
          </Button>
        )}
        {onDismiss && !running && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={() => onDismiss(id)}
            data-testid={`${testId}-dismiss`}
          >
            <X />
          </Button>
        )}
      </span>
    </div>
  );
}

export interface AdmitRowsProps {
  pendings: PendingEnrollment[];
  /** 引擎状态：忙碌 / 未确认 / 失败提示 / 加入进度都从这里读。 */
  engine: EnrollmentEngineState;
  writable: boolean;
  blockedHint: string;
  onConfirm: (pending: PendingEnrollment) => void;
  /** 取消一条待确认记录（误点「添加」的回退路径）：仅删本地 pending，中继侧记录会自然过期。 */
  onCancel: (pending: PendingEnrollment) => void;
  onResendKey: (enrollmentId: string) => void;
  /** 「通行密钥需验证两次」提示的判据。 */
  passkeyTwice: PasskeyTwiceContext;
}

/** 待确认列表 + 已收尾的加入结果（pending 已删，结果留到用户关掉）。 */
export function AdmitRows({ pendings, engine, onResendKey, ...row }: AdmitRowsProps) {
  const { t } = useTranslation();
  const results = Object.entries(engine.progressById).filter(
    ([id]) => !pendings.some((pending) => pending.hubEnrollmentId === id)
  );
  return (
    <>
      {pendings.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="nodes-pending-list">
          {pendings.map((pending) => (
            <PendingRow key={pending.hubEnrollmentId} pending={pending} engine={engine} {...row} />
          ))}
        </ul>
      )}
      {results.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="nodes-admit-results">
          {results.map(([id, progress]) => (
            <li key={id} className="rounded-lg bg-muted/50 px-2 py-1.5">
              <AdmitOutcome
                id={id}
                progress={progress}
                doneText={t('nodes.enrollment.admitted')}
                testId={`nodes-admit-result-${id}`}
                onResendKey={onResendKey}
                onDismiss={dismissAdmitProgress}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function PendingStatus({ id, engine }: { id: string; engine: EnrollmentEngineState }) {
  const { t } = useTranslation();
  const failureKey = engine.failureById[id];
  const invalidKey = engine.invalidById[id];
  if (failureKey || invalidKey) {
    return (
      <span className="text-destructive" role="alert" data-testid={`nodes-pending-failure-${id}`}>
        {failureKey ? admitFailureText(t, failureKey) : t(invalidKey)}
      </span>
    );
  }
  return engine.unconfirmedIds.includes(id)
    ? t('nodes.enrollment.relayNotConfirmed')
    : t('nodes.enrollment.pending');
}

/** 一条待确认记录。上级未确认或上次确认失败时，按钮换成「重试」口径。 */
function PendingRow({
  pending,
  engine,
  writable,
  blockedHint,
  onConfirm,
  onCancel,
  passkeyTwice,
}: Omit<AdmitRowsProps, 'pendings' | 'onResendKey'> & { pending: PendingEnrollment }) {
  const { t } = useTranslation();
  const id = pending.hubEnrollmentId;
  // 正在跑 admit 时确认与取消都要禁用——取消一条 append 未定的记录会丢字节。
  const busy = engine.busyIds.includes(id);
  const unconfirmed = engine.unconfirmedIds.includes(id);
  const retry = unconfirmed || Boolean(engine.failureById[id]);
  const idleLabel = retry ? t('nodes.enrollment.retry') : t('nodes.enrollment.confirmPending');
  const stepLabel = busy ? admitStepLabel(t, engine.progressById[id]) : null;
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/50 px-2 py-1.5 text-xs"
      data-testid={`nodes-pending-${id}`}
    >
      <span className="min-w-0">
        <PendingStatus id={id} engine={engine} />
        <span className="ml-2 font-mono text-muted-foreground">
          {pending.name ?? pending.enrollPk.slice(0, 12)}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          size="xs"
          disabled={busy || !writable}
          title={writable ? undefined : blockedHint}
          onClick={() => onConfirm(pending)}
          data-testid={`nodes-pending-confirm-${id}`}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Check />}
          {stepLabel ?? idleLabel}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={busy}
          onClick={() => onCancel(pending)}
          data-testid={`nodes-pending-cancel-${id}`}
        >
          <X />
          {t('nodes.enrollment.cancelPending')}
        </Button>
      </span>
      {/* 未确认时只重发已签好的那条，第一次验证早做过了，不再说「两次」。 */}
      {!unconfirmed && (
        <PasskeyTwiceHint
          context={passkeyTwice}
          testId={`nodes-pending-passkey-twice-${id}`}
          className="basis-full text-muted-foreground"
        />
      )}
    </li>
  );
}
