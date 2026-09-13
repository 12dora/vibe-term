// 状态色：badge / 灯 / 芯片 / 正文 / 提示条共用同一档位。
// 各表面的 Tailwind 保持原样（同档不同表面的 class 本来就不一样），调用方只换档不换色值。

export type Tone = 'ok' | 'warn' | 'muted' | 'blocked' | 'info';

export const TONE_CLASS = {
  badge: {
    ok: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
    warn: 'border-orange-400/40 text-orange-500 dark:text-orange-400',
    muted: 'border-border text-muted-foreground',
  },
  dot: {
    ok: 'bg-emerald-500',
    blocked: 'bg-destructive',
    muted: 'bg-muted-foreground/40',
  },
  chip: {
    blocked: 'border-destructive/40 text-destructive',
    warn: 'border-amber-500/40 text-amber-700 dark:text-amber-400',
    muted: 'border-border',
  },
  text: {
    ok: 'text-emerald-500',
    warn: 'text-amber-600 dark:text-amber-400',
    muted: 'text-muted-foreground',
    blocked: 'text-destructive',
    info: 'text-muted-foreground',
  },
  notice: {
    info: 'bg-muted/60 text-muted-foreground',
    ok: 'bg-primary/10 text-primary',
    warn: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    blocked: 'bg-destructive/10 text-destructive',
    muted: 'bg-muted/60 text-muted-foreground',
  },
  cardNotice: {
    blocked: 'bg-destructive/10 text-destructive',
    warn: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
    muted: 'bg-muted/60 text-muted-foreground',
  },
} as const;

export type ToneSurface = keyof typeof TONE_CLASS;

export function toneClass<S extends ToneSurface>(
  surface: S,
  tone: keyof (typeof TONE_CLASS)[S]
): (typeof TONE_CLASS)[S][typeof tone] {
  return TONE_CLASS[surface][tone];
}
