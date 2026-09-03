// 远程访问向导的步骤外壳与几个小展示件。

import { Badge } from '@tmex/ui/badge';
import { Check, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { InfoRow, type InfoRowProps } from '../components/form-primitives';
import type { StepState } from './tunnel-model';
import { jobStepKey } from './tunnel-model';

export function WizardStepCard({
  index,
  title,
  description,
  state,
  testId,
  tag,
  children,
}: {
  index: number;
  title: string;
  description?: string;
  state: StepState;
  testId: string;
  /** 可选步骤的标签（推荐 / 可选）。 */
  tag?: string;
  children?: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      data-step-state={state}
      className={`rounded-xl p-3 ring-1 transition-colors duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none ${
        state === 'current' ? 'bg-primary/5 ring-primary' : 'bg-card ring-foreground/10'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <StepMarker index={index} state={state} testId={`${testId}-marker`} />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="space-y-0.5">
            <h3 className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
              {title}
              {tag && (
                <Badge variant="secondary" data-testid={`${testId}-tag`}>
                  {tag}
                </Badge>
              )}
            </h3>
            {description && <p className="text-xs text-muted-foreground">{description}</p>}
          </div>
          {children}
        </div>
      </div>
    </section>
  );
}

function StepMarker({
  index,
  state,
  testId,
}: {
  index: number;
  state: StepState;
  testId: string;
}) {
  return (
    <span
      data-testid={testId}
      className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium ${
        state === 'done'
          ? 'bg-primary/15 text-primary'
          : state === 'current'
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground'
      }`}
    >
      {state === 'done' ? <Check className="size-3" /> : index}
    </span>
  );
}

export function ProgressRow({ label, testId }: { label: string; testId: string }) {
  return (
    <div
      className="flex items-center gap-1.5 rounded-lg bg-muted/60 p-2 text-xs text-muted-foreground"
      data-testid={testId}
    >
      <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
      {label}
    </div>
  );
}

/** 后台 job 的进度行：已知步骤走本地化文案，未知步骤原样展示服务端标识。 */
export function JobProgress({ step, testId }: { step: string | null; testId: string }) {
  const { t } = useTranslation();
  const key = jobStepKey(step);
  return <ProgressRow label={key ? t(key) : (step ?? t('common.loading'))} testId={testId} />;
}

export function DetailRow(props: Omit<InfoRowProps, 'labelWidth'>) {
  return <InfoRow {...props} labelWidth="narrow" />;
}
