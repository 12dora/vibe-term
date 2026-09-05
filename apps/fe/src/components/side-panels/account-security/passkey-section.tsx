import {
  isPasskeyUsableHere,
  registerPasskey,
  removePasskey,
} from '@/auth/account-security-actions';
import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import type { AuthApi, PasskeySummary } from '@tmex/api-client/auth/index';
import { errorMessage } from '@tmex/shared';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { Fingerprint, Loader2, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { securityActionErrorText } from '../account-security-password';
import { Feedback, Section } from './section';
import type { ResolvedMode, SecurityActionFeedback } from './types';

export function PasskeySection({
  mode,
  api,
  uid,
  passkeys,
  prompt,
  listError,
  onDone,
  publishFeedback,
}: {
  mode: ResolvedMode;
  api: AuthApi;
  uid: string;
  passkeys: PasskeySummary[];
  prompt: CredentialPromptHandle;
  listError: string | null;
  onDone: () => void;
  publishFeedback: (next: SecurityActionFeedback | null) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = useCallback(async () => {
    setError(null);
    // 换了一个动作，上一条反馈（如改密成功）不再是当前状态的说明。
    publishFeedback(null);
    setBusy(true);
    try {
      const result = await prompt.withSigner(
        (signer) => registerPasskey({ api, uid, name: name || 'passkey', signer }),
        { purpose: 'passkey' }
      );
      if (!result) return;
      if (!result.ok) {
        setError(securityActionErrorText(t, result.code));
        return;
      }
      setName('');
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [api, name, onDone, prompt, publishFeedback, t, uid]);

  const remove = useCallback(
    async (credentialId: string) => {
      setError(null);
      publishFeedback(null);
      setBusy(true);
      try {
        const result = await prompt.withSigner(
          (signer) => removePasskey({ api, uid, credentialId, signer }),
          { purpose: 'passkey' }
        );
        if (!result) return;
        if (!result.ok) {
          setError(securityActionErrorText(t, result.code));
          return;
        }
        onDone();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [api, onDone, prompt, publishFeedback, t, uid]
  );

  return (
    <Section
      title={t('auth.security.passkeys')}
      description={
        mode.passkeyAvailable
          ? t('auth.security.passkeyNote')
          : t('auth.security.passkeyUnavailable')
      }
    >
      {listError ? (
        <Feedback tone="error" text={t('auth.security.passkeyListFailed', { error: listError })} />
      ) : null}

      {passkeys.length > 0 ? (
        <ul className="flex flex-col gap-1" data-testid="security-passkey-list">
          {passkeys.map((passkey) => {
            // 本入口用不了的凭证（`usableHere===false`，B2-8）灰掉：它在这里既签不了记录
            // 也登不了录，但仍然要能看见、能删。
            const usable = isPasskeyUsableHere(passkey);
            return (
              <li
                key={passkey.credential_id}
                className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs ${
                  usable ? 'bg-muted/50' : 'bg-muted/20 opacity-60'
                }`}
                data-usable-here={usable ? 'true' : 'false'}
                data-testid={`security-passkey-row-${passkey.credential_id}`}
              >
                <span className="truncate">
                  {passkey.name || passkey.credential_id}
                  <span className="ml-2 text-muted-foreground">{passkey.origin}</span>
                  {usable ? null : (
                    <span
                      className="ml-2 text-muted-foreground"
                      data-testid={`security-passkey-other-origin-${passkey.credential_id}`}
                    >
                      {t('auth.security.passkeyOtherOrigin')}
                    </span>
                  )}
                </span>
                <Button
                  type="button"
                  variant="destructive"
                  size="xs"
                  disabled={busy}
                  onClick={() => void remove(passkey.credential_id)}
                  data-testid={`security-passkey-remove-${passkey.credential_id}`}
                >
                  <Trash2 />
                  {t('common.delete')}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <Input
        placeholder={t('auth.security.passkeyName')}
        value={name}
        data-testid="security-passkey-name"
        onChange={(event) => setName(event.target.value)}
      />

      <p
        className="text-xs text-muted-foreground"
        data-testid="security-passkey-second-factor-hint"
      >
        {t('auth.security.passkeySecondFactorHint')}
      </p>

      {prompt.passkeys.length > 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="security-passkey-signing-note">
          {t('auth.security.signWithExistingPasskey')}
        </p>
      ) : null}

      {error ? <Feedback tone="error" text={error} /> : null}

      <div>
        <Button
          type="button"
          disabled={busy || !mode.passkeyAvailable}
          onClick={() => void add()}
          data-testid="security-passkey-add"
        >
          {busy ? <Loader2 className="animate-spin" /> : <Fingerprint />}
          {t('auth.security.registerPasskey')}
        </Button>
      </div>
    </Section>
  );
}
