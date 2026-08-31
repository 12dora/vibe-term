// 访问控制（Cloudflare Access）：凭证 → 允许访问的用户 → 应用状态。
//
// Access 是可选的加固层：没有它隧道照样能开，只是任何人都能打到 tmex 的登录页（或裸界面）。
// API token 与 account id 只往服务端送一次，状态里永远只回「是否已保存」。

import type { TunnelStatusResponse } from '@tmex/shared';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@tmex/ui/alert-dialog';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { Loader2, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField, SetupNotice, SwitchRow } from '../nodes/setup/form-parts';
import {
  type AccessRuleDraft,
  type AccessRuleKind,
  accessConfigureHostname,
  accessSyncHostname,
  canApplyAccess,
  canSyncAccess,
  configureAccessRequest,
  externalAccessState,
  ruleDraftError,
  ruleDraftsFrom,
  shouldOfferAccessSync,
  toAccessRules,
} from './access-model';
import { type ExposureState, ExposureWarning } from './exposure';
import { DetailRow, JobProgress } from './step-shell';
import type { TunnelActions } from './tunnel-actions';
import { accessEffective, wouldDropLastProtection } from './tunnel-model';

export function AccessStep({
  status,
  actions,
  draftHostname,
  exposure,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
  /** 向导里已确认的主机名草稿：隧道还没建时，Access 就按它配。 */
  draftHostname: string;
  exposure: ExposureState;
}) {
  const { t } = useTranslation();
  const access = status.access;

  return (
    <div className="space-y-4" data-testid="remote-access-access">
      {access.lastError && (
        <SetupNotice tone="error" testId="remote-access-access-last-error">
          {t('settings.remoteAccess.access.lastError', { message: access.lastError })}
        </SetupNotice>
      )}

      {!access.configured && <ExternalAccessNotice status={status} />}

      {access.hasCredentials ? (
        <SavedCredentials status={status} actions={actions} />
      ) : (
        <CredentialsForm actions={actions} />
      )}

      {access.hasCredentials && (
        <RulesEditor
          // 应用 / 同步回来的规则是服务端真值：一变就重挂，丢掉过期的本地草稿。
          key={access.rules.map((rule) => `${rule.kind}:${rule.value}`).join(',')}
          status={status}
          actions={actions}
          draftHostname={draftHostname}
        />
      )}

      {access.configured && (
        <AccessAppStatus status={status} actions={actions} exposure={exposure} />
      )}
    </div>
  );
}

/**
 * 只读探测：Cloudflare 控制台上有没有覆盖这个主机名的 Access 应用。
 * 它与 `access.configured`（tmex 托管、网关校验 JWT）是两回事，措辞上必须分清；
 * 「查不了」（无凭证 / API 失败）也不能说成「未配置」。
 */
function ExternalAccessNotice({ status }: { status: TunnelStatusResponse }) {
  const { t } = useTranslation();
  const hostname = accessSyncHostname(status);
  const state = externalAccessState(status);
  const teamDomain = status.external.externalAccess?.teamDomain;
  if (hostname === null) return null;

  return (
    <SetupNotice
      tone={state === 'unknown' ? 'warning' : 'info'}
      testId={`remote-access-access-probe-${state}`}
    >
      <p>{t(`settings.remoteAccess.access.probe.${state}`, { hostname })}</p>
      {state === 'covered' && teamDomain && (
        <p data-testid="remote-access-access-probe-team">
          {t('settings.remoteAccess.access.probe.teamDomain', { teamDomain })}
        </p>
      )}
      {/* 探测可能用的是 cloudflared 的 cert.pem，未必存过凭证：同步 / 应用按钮此时还不在页面上。 */}
      {state !== 'unknown' && !status.access.hasCredentials && (
        <p data-testid="remote-access-access-probe-need-credentials">
          {t('settings.remoteAccess.access.probe.needCredentials')}
        </p>
      )}
    </SetupNotice>
  );
}

function CredentialsForm({ actions }: { actions: TunnelActions }) {
  const { t } = useTranslation();
  const [apiToken, setApiToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const ready = apiToken.trim().length > 0 && accountId.trim().length > 0;

  return (
    <div className="space-y-3" data-testid="remote-access-access-credentials">
      <SectionTitle text={t('settings.remoteAccess.access.credentials.title')} />
      <FormField
        id="remote-access-access-token"
        label={t('settings.remoteAccess.access.credentials.apiToken')}
        hint={t('settings.remoteAccess.access.credentials.apiTokenHint')}
      >
        <Input
          id="remote-access-access-token"
          data-testid="remote-access-access-token"
          type="password"
          autoComplete="off"
          value={apiToken}
          disabled={actions.busy}
          onChange={(event) => setApiToken(event.target.value)}
        />
      </FormField>
      <FormField
        id="remote-access-access-account"
        label={t('settings.remoteAccess.access.credentials.accountId')}
        hint={t('settings.remoteAccess.access.credentials.accountIdHint')}
      >
        <Input
          id="remote-access-access-account"
          data-testid="remote-access-access-account"
          value={accountId}
          disabled={actions.busy}
          onChange={(event) => setAccountId(event.target.value)}
        />
      </FormField>
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={actions.busy || !ready}
          onClick={() =>
            actions.run({
              action: 'set_access_credentials',
              apiToken: apiToken.trim(),
              accountId: accountId.trim(),
            })
          }
          data-testid="remote-access-access-save-credentials"
        >
          {actions.pending === 'set_access_credentials' ? (
            <Loader2 className="animate-spin" />
          ) : null}
          {t('settings.remoteAccess.access.credentials.save')}
        </Button>
      </div>
    </div>
  );
}

function SavedCredentials({
  status,
  actions,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2" data-testid="remote-access-access-credentials-saved">
      <SectionTitle text={t('settings.remoteAccess.access.credentials.title')} />
      <SetupNotice tone="success">
        {t('settings.remoteAccess.access.credentials.saved')}
      </SetupNotice>
      <div className="space-y-0.5">
        <DetailRow
          label={t('settings.remoteAccess.access.credentials.accountId')}
          testId="remote-access-access-account-id"
        >
          <span className="font-mono">{status.access.accountId ?? '—'}</span>
        </DetailRow>
        <DetailRow
          label={t('settings.remoteAccess.access.credentials.teamDomain')}
          testId="remote-access-access-team-domain"
        >
          <span className="font-mono">{status.access.teamDomain ?? '—'}</span>
        </DetailRow>
      </div>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={actions.busy}
        onClick={() => actions.run({ action: 'clear_access_credentials' })}
        data-testid="remote-access-access-clear-credentials"
      >
        {actions.pending === 'clear_access_credentials' ? (
          <Loader2 className="animate-spin" />
        ) : (
          <X />
        )}
        {t('settings.remoteAccess.access.credentials.clear')}
      </Button>
    </div>
  );
}

function RulesEditor({
  status,
  actions,
  draftHostname,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
  draftHostname: string;
}) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<AccessRuleDraft[]>(() =>
    status.access.rules.length > 0
      ? ruleDraftsFrom(status.access.rules)
      : [{ key: 'rule-0', kind: 'email', value: '' }]
  );
  const nextKey = useRef(1);
  const job = status.job;
  const running = job?.kind === 'access' && job.state === 'running';
  const hostname = accessConfigureHostname(status, draftHostname);
  const syncHostname = accessSyncHostname(status);
  const applicable = canApplyAccess(status, drafts, draftHostname);

  const patch = (key: string, next: Partial<AccessRuleDraft>) =>
    setDrafts((current) =>
      current.map((draft) => (draft.key === key ? { ...draft, ...next } : draft))
    );

  return (
    <div className="space-y-3" data-testid="remote-access-access-rules">
      <SectionTitle text={t('settings.remoteAccess.access.rules.title')} />
      <p className="text-xs text-muted-foreground">
        {t('settings.remoteAccess.access.rules.description')}
      </p>

      <div className="space-y-2">
        {drafts.map((draft, index) => (
          <RuleRow
            key={draft.key}
            draft={draft}
            index={index}
            disabled={actions.busy}
            removable={drafts.length > 1}
            onKind={(kind) => patch(draft.key, { kind })}
            onValue={(value) => patch(draft.key, { value })}
            onRemove={() =>
              setDrafts((current) => current.filter((item) => item.key !== draft.key))
            }
          />
        ))}
      </div>

      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={actions.busy}
        onClick={() => {
          const key = `rule-${nextKey.current++}`;
          setDrafts((current) => [...current, { key, kind: 'email', value: '' }]);
        }}
        data-testid="remote-access-access-add-rule"
      >
        <Plus />
        {t('settings.remoteAccess.access.rules.add')}
      </Button>

      {hostname === null && (
        <SetupNotice tone="info" testId="remote-access-access-no-hostname">
          {t('settings.remoteAccess.access.rules.needHostname')}
        </SetupNotice>
      )}

      {shouldOfferAccessSync(status) && (
        <SetupNotice tone="info" testId="remote-access-access-sync-hint">
          {t('settings.remoteAccess.access.sync.hint', { hostname: syncHostname })}
        </SetupNotice>
      )}

      {running && <JobProgress step={job.step} testId="remote-access-access-progress" />}

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={actions.busy || !canSyncAccess(status)}
          onClick={() => actions.run({ action: 'sync_access' })}
          data-testid="remote-access-access-sync"
        >
          {actions.pending === 'sync_access' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {t('settings.remoteAccess.access.sync.action')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={actions.busy || !applicable}
          onClick={() =>
            actions.run(configureAccessRequest(status, toAccessRules(drafts), draftHostname))
          }
          data-testid="remote-access-access-apply"
        >
          {actions.pending === 'configure_access' ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Upload />
          )}
          {t('settings.remoteAccess.access.rules.apply')}
        </Button>
      </div>
    </div>
  );
}

const RULE_KINDS: AccessRuleKind[] = ['email', 'email_domain'];

function RuleRow({
  draft,
  index,
  disabled,
  removable,
  onKind,
  onValue,
  onRemove,
}: {
  draft: AccessRuleDraft;
  index: number;
  disabled: boolean;
  removable: boolean;
  onKind: (kind: AccessRuleKind) => void;
  onValue: (value: string) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const error = ruleDraftError(draft);

  return (
    <div className="space-y-1" data-testid={`remote-access-access-rule-${index}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex shrink-0 rounded-lg bg-muted p-0.5">
          {RULE_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              disabled={disabled}
              aria-pressed={draft.kind === kind}
              className={`rounded-[calc(var(--radius-lg)-2px)] px-2 py-1 text-xs transition-colors duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none ${
                draft.kind === kind
                  ? 'bg-background font-medium shadow-xs'
                  : 'text-muted-foreground'
              } ${disabled ? 'pointer-events-none opacity-60' : ''}`}
              onClick={() => onKind(kind)}
              data-testid={`remote-access-access-rule-${index}-kind-${kind}`}
            >
              {t(`settings.remoteAccess.access.rules.kind.${kind}`)}
            </button>
          ))}
        </div>
        <Input
          className="min-w-40 flex-1"
          value={draft.value}
          disabled={disabled}
          aria-label={t(`settings.remoteAccess.access.rules.kind.${draft.kind}`)}
          placeholder={t(`settings.remoteAccess.access.rules.placeholder.${draft.kind}`)}
          onChange={(event) => onValue(event.target.value)}
          data-testid={`remote-access-access-rule-${index}-value`}
        />
        {removable && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={disabled}
            aria-label={t('settings.remoteAccess.access.rules.remove')}
            onClick={onRemove}
            data-testid={`remote-access-access-rule-${index}-remove`}
          >
            <X />
          </Button>
        )}
      </div>
      {error === 'invalid' && (
        <p
          className="text-xs text-destructive"
          data-testid={`remote-access-access-rule-${index}-error`}
        >
          {t(`settings.remoteAccess.access.rules.invalid.${draft.kind}`)}
        </p>
      )}
    </div>
  );
}

function AccessAppStatus({
  status,
  actions,
  exposure,
}: {
  status: TunnelStatusResponse;
  actions: TunnelActions;
  exposure: ExposureState;
}) {
  const { t } = useTranslation();
  const access = status.access;
  const [confirmRemove, setConfirmRemove] = useState(false);
  // 关校验 / 删应用会拿掉最后一道保护时，先要用户明确确认（与开隧道同一条契约）。
  const dropsProtection = wouldDropLastProtection(status);
  const blocked = dropsProtection && !exposure.acknowledged;

  return (
    <div className="space-y-3" data-testid="remote-access-access-app">
      <SectionTitle text={t('settings.remoteAccess.access.app.title')} />
      <div className="space-y-0.5">
        <DetailRow
          label={t('settings.remoteAccess.access.app.appId')}
          testId="remote-access-access-app-id"
        >
          <span className="font-mono">{access.appId ?? '—'}</span>
        </DetailRow>
        <DetailRow
          label={t('settings.remoteAccess.access.app.aud')}
          testId="remote-access-access-aud"
        >
          <span className="font-mono">{access.aud ?? '—'}</span>
        </DetailRow>
        <DetailRow
          label={t('settings.remoteAccess.access.app.hostname')}
          testId="remote-access-access-app-hostname"
        >
          <span className="font-mono">{access.hostname ?? '—'}</span>
        </DetailRow>
        <DetailRow
          label={t('settings.remoteAccess.access.app.rules')}
          testId="remote-access-access-app-rules"
        >
          {access.rules.length === 0
            ? t('settings.remoteAccess.access.app.noRules')
            : access.rules
                .map(
                  (rule) =>
                    `${t(`settings.remoteAccess.access.rules.kind.${rule.kind}`)}: ${rule.value}`
                )
                .join('; ')}
        </DetailRow>
      </div>

      {/* 隧道还没建时不报不匹配：向导允许先按已确认的主机名把 Access 配好。 */}
      {access.enforceJwt && status.config.hostname !== null && !accessEffective(status) && (
        <SetupNotice tone="warning" testId="remote-access-access-hostname-mismatch">
          {t('settings.remoteAccess.access.app.hostnameMismatch')}
        </SetupNotice>
      )}

      {dropsProtection && (
        <ExposureWarning
          exposure={exposure}
          id="remote-access-access-drop-ack"
          testId="remote-access-access-drop-exposure"
          variant="drop"
        />
      )}

      <SwitchRow
        id="remote-access-access-enforce"
        label={t('settings.remoteAccess.access.app.enforce')}
        hint={t('settings.remoteAccess.access.app.enforceHint')}
        checked={access.enforceJwt}
        disabled={actions.busy || blocked}
        onCheckedChange={(checked) =>
          actions.run({ action: 'set_access_enforce', enforceJwt: checked })
        }
      />
      {!access.enforceJwt && (
        <SetupNotice tone="warning" testId="remote-access-access-enforce-off">
          {t('settings.remoteAccess.access.app.enforceOff')}
        </SetupNotice>
      )}

      <Button
        type="button"
        size="xs"
        variant="destructive"
        disabled={actions.busy}
        onClick={() => setConfirmRemove(true)}
        data-testid="remote-access-access-remove"
      >
        {actions.pending === 'remove_access' ? <Loader2 className="animate-spin" /> : <Trash2 />}
        {t('settings.remoteAccess.access.app.remove')}
      </Button>

      {confirmRemove && (
        <AlertDialog
          open
          onOpenChange={(next) => {
            if (!next) setConfirmRemove(false);
          }}
        >
          <AlertDialogContent data-testid="remote-access-access-confirm-remove">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('settings.remoteAccess.access.confirmRemove.title')}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t('settings.remoteAccess.access.confirmRemove.description')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {dropsProtection && (
              <ExposureWarning
                exposure={exposure}
                id="remote-access-access-remove-ack"
                testId="remote-access-access-remove-exposure"
                variant="drop"
              />
            )}
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setConfirmRemove(false)}>
                {t('settings.remoteAccess.access.confirmRemove.cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={blocked}
                onClick={() => {
                  setConfirmRemove(false);
                  actions.run({ action: 'remove_access' });
                }}
                data-testid="remote-access-access-confirm-remove-confirm"
              >
                {t('settings.remoteAccess.access.confirmRemove.confirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

function SectionTitle({ text }: { text: string }) {
  return <h4 className="text-xs font-medium tracking-wide text-muted-foreground">{text}</h4>;
}
