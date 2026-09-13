import { TONE_CLASS } from '@/lib/tone';

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-background p-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

const FEEDBACK_TONE = {
  error: TONE_CLASS.text.blocked,
  ok: TONE_CLASS.text.ok,
  notice: TONE_CLASS.text.muted,
} as const;

export function Feedback({ tone, text }: { tone: keyof typeof FEEDBACK_TONE; text: string }) {
  return (
    <p className={`text-xs ${FEEDBACK_TONE[tone]}`} data-testid={`security-${tone}`}>
      {text}
    </p>
  );
}
