// SAN 列表编辑：证书只对列表里的名字有效，浏览器访问其它名字仍然会报证书错误。

import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { Plus, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Field } from './parts';
import { isValidSan, parseSansInput } from './tls-form';

export function SansEditor({
  sans,
  disabled,
  error,
  onChange,
}: {
  sans: string[];
  disabled: boolean;
  error?: string;
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');

  const add = useCallback(() => {
    const parsed = parseSansInput(draft);
    if (parsed.length === 0) return;
    onChange(Array.from(new Set([...sans, ...parsed])));
    setDraft('');
  }, [draft, onChange, sans]);

  return (
    <Field
      id="https-sans"
      label={t('nodes.https.selfsigned.sans')}
      hint={t('nodes.https.selfsigned.sansHint')}
      {...(error ? { error } : {})}
    >
      <div className="flex flex-wrap gap-1.5" data-testid="https-sans-list">
        {sans.length === 0 && (
          <span className="text-xs text-muted-foreground" data-testid="https-sans-empty">
            {t('nodes.https.selfsigned.sansEmpty')}
          </span>
        )}
        {sans.map((san) => (
          <span
            key={san}
            data-testid="https-san-chip"
            data-invalid={isValidSan(san) ? 'false' : 'true'}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] ring-1 ${
              isValidSan(san)
                ? 'bg-muted/60 ring-foreground/10'
                : 'bg-destructive/10 text-destructive ring-destructive/30'
            }`}
          >
            {san}
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              disabled={disabled}
              aria-label={t('nodes.https.selfsigned.sansRemove', { name: san })}
              onClick={() => onChange(sans.filter((item) => item !== san))}
            >
              <X />
            </Button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          id="https-sans"
          data-testid="https-sans-input"
          value={draft}
          disabled={disabled}
          placeholder={t('nodes.https.selfsigned.sansPlaceholder')}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || !draft.trim()}
          onClick={add}
          data-testid="https-sans-add"
        >
          <Plus />
          {t('nodes.https.selfsigned.sansAdd')}
        </Button>
      </div>
    </Field>
  );
}
