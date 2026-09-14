// 连接详情里的「接入密码」一行：掩码 / 未记录、按需揭示、修改对话框。

import {
  type UseMeshRelayResult,
  defaultEnrollPasswordRelay,
  enrollPasswordRelays,
} from '@/node/mesh-relay';
import {
  type RelayLinkStatus,
  type RelayTenantApi,
  defaultRelayTenantApi,
} from '@vibeterm/api-client/relay/tenant-api';
import { Button } from '@vibeterm/ui/button';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyableValue, Row } from '../copy-feedback';
import { RelayEnrollPasswordDialog } from './relay-enroll-password-dialog';
import { relayLabel } from './relay-rows';

export const ENROLL_PASSWORD_MASK = '••••••••';

export function enrollPasswordKnown(row: RelayLinkStatus | null): boolean {
  return row?.enrollPassword?.known === true;
}

export async function loadEnrollPassword(
  url: string,
  api: RelayTenantApi = defaultRelayTenantApi
): Promise<string | null> {
  const view = await api.enrollPassword(url);
  return view.known ? (view.password ?? '') : null;
}

export function RelayPasswordValue({
  known,
  revealed,
  plaintext,
  loading,
  onReveal,
  onChange,
}: {
  known: boolean;
  revealed: boolean;
  plaintext: string | null;
  loading: boolean;
  onReveal: () => void;
  onChange: () => void;
}) {
  const { t } = useTranslation();
  if (!known) {
    return (
      <>
        <span data-testid="nodes-relay-enroll-password">
          {t('relay.tenant.strip.enrollPasswordUnknown')}
        </span>
        <ChangeButton onClick={onChange} />
      </>
    );
  }
  return (
    <>
      {revealed && plaintext !== null ? (
        <CopyableValue value={plaintext} testId="nodes-relay-enroll-password" mono />
      ) : (
        <code
          className="min-w-0 truncate rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[11px]"
          data-testid="nodes-relay-enroll-password"
        >
          {ENROLL_PASSWORD_MASK}
        </code>
      )}
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={loading}
        aria-label={t(
          revealed ? 'relay.tenant.enrollPassword.hide' : 'relay.tenant.enrollPassword.show'
        )}
        onClick={onReveal}
        data-testid="nodes-relay-enroll-password-reveal"
      >
        {loading ? (
          <Loader2 className="animate-spin motion-reduce:animate-none" />
        ) : revealed ? (
          <EyeOff />
        ) : (
          <Eye />
        )}
      </Button>
      <ChangeButton onClick={onChange} />
    </>
  );
}

function ChangeButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      onClick={onClick}
      data-testid="nodes-relay-enroll-password-change"
    >
      {t('relay.tenant.strip.enrollPasswordChange')}
    </Button>
  );
}

function usePasswordTarget(targets: RelayLinkStatus[]) {
  const fallback = defaultEnrollPasswordRelay(targets);
  const targetKey = targets.map((row) => row.url).join('\0');
  const [selectedUrl, setSelectedUrl] = useState(fallback?.url ?? '');
  const selected = targets.find((row) => row.url === selectedUrl) ?? fallback;
  const [lastKey, setLastKey] = useState(targetKey);
  if (lastKey !== targetKey) {
    setLastKey(targetKey);
    if (!targets.some((row) => row.url === selectedUrl)) setSelectedUrl(fallback?.url ?? '');
  }
  return { selected, setSelectedUrl };
}

function usePasswordReveal(url: string, api: RelayTenantApi) {
  const [revealed, setRevealed] = useState(false);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastUrl, setLastUrl] = useState(url);
  if (lastUrl !== url) {
    setLastUrl(url);
    setRevealed(false);
    setPlaintext(null);
  }
  const reveal = () => {
    if (revealed) {
      setRevealed(false);
      return;
    }
    if (plaintext !== null) {
      setRevealed(true);
      return;
    }
    setBusy(true);
    void loadEnrollPassword(url, api).then(
      (value) => {
        setBusy(false);
        setPlaintext(value ?? '');
        setRevealed(true);
      },
      () => setBusy(false)
    );
  };
  const reset = () => {
    setRevealed(false);
    setPlaintext(null);
  };
  return { revealed, plaintext, busy, reveal, reset };
}

function RelaySelect({
  targets,
  url,
  onChange,
}: {
  targets: RelayLinkStatus[];
  url: string;
  onChange: (url: string) => void;
}) {
  const { t } = useTranslation();
  if (targets.length <= 1) return null;
  return (
    <select
      className="max-w-40 truncate rounded border border-border bg-background px-1.5 py-0.5 text-[11px]"
      value={url}
      aria-label={t('relay.tenant.enrollPassword.select')}
      data-testid="nodes-relay-enroll-password-relay"
      onChange={(event) => onChange(event.target.value)}
    >
      {targets.map((row) => (
        <option key={row.url} value={row.url}>
          {relayLabel(row.url)}
        </option>
      ))}
    </select>
  );
}

export function RelayPasswordRow({
  relay,
  api = defaultRelayTenantApi,
}: {
  relay: UseMeshRelayResult;
  api?: RelayTenantApi;
}) {
  const { t } = useTranslation();
  const targets = relay.relayMode ? enrollPasswordRelays(relay) : [];
  const { selected, setSelectedUrl } = usePasswordTarget(targets);
  const url = selected?.url ?? '';
  const revealState = usePasswordReveal(url, api);
  const [dialogOpen, setDialogOpen] = useState(false);
  if (!selected) return null;
  return (
    <>
      <Row label={t('relay.tenant.strip.enrollPassword')} testId="nodes-relay-enroll-password-row">
        <RelaySelect targets={targets} url={url} onChange={setSelectedUrl} />
        <RelayPasswordValue
          known={enrollPasswordKnown(selected)}
          revealed={revealState.revealed}
          plaintext={revealState.plaintext}
          loading={revealState.busy}
          onReveal={revealState.reveal}
          onChange={() => setDialogOpen(true)}
        />
      </Row>
      {dialogOpen && (
        <RelayEnrollPasswordDialog
          open
          url={url}
          known={enrollPasswordKnown(selected)}
          api={api}
          onOpenChange={setDialogOpen}
          onDone={() => {
            revealState.reset();
            relay.refresh();
          }}
        />
      )}
    </>
  );
}
