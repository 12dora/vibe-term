// 目标目录里已有同名项时的三选一：替换 / 跳过 / 取消。以 Promise 形式给执行器用，
// 同一时刻只挂一个；新的询问会让上一个按「取消」落定。

import { Button } from '@vibeterm/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibeterm/ui/dialog';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type ConflictAnswer = 'replace' | 'skip' | 'cancel';

export const CONFLICT_LIST_LIMIT = 5;

export interface ConflictTitle {
  key: 'explorer.conflict.titleOne' | 'explorer.conflict.titleMany';
  params: { name: string } | { count: number };
}

/** 恰好一项用带名字的标题，多项用数量标题（不走 i18next 复数，键在这里选）。 */
export function conflictTitle(names: readonly string[]): ConflictTitle {
  if (names.length === 1) {
    return { key: 'explorer.conflict.titleOne', params: { name: names[0] ?? '' } };
  }
  return { key: 'explorer.conflict.titleMany', params: { count: names.length } };
}

/** 多于一项时列出前几个名字，其余折成一个数量。 */
export function conflictNameList(
  names: readonly string[],
  limit = CONFLICT_LIST_LIMIT
): { shown: string[]; more: number } {
  if (names.length <= 1) return { shown: [], more: 0 };
  return { shown: names.slice(0, limit), more: Math.max(0, names.length - limit) };
}

function ConflictNames({ names }: { names: readonly string[] }) {
  const { t } = useTranslation();
  const { shown, more } = conflictNameList(names);
  if (shown.length === 0) return null;
  return (
    <ul
      className="flex flex-col gap-0.5 rounded-lg bg-muted/50 px-3 py-2 font-mono text-xs text-muted-foreground"
      data-testid="explorer-conflict-names"
    >
      {shown.map((name) => (
        <li key={name} className="truncate">
          {name}
        </li>
      ))}
      {more > 0 && <li className="font-sans">{t('files.ops.deleteMore', { count: more })}</li>}
    </ul>
  );
}

export function ExplorerConflictDialog({
  open,
  names,
  onAnswer,
}: {
  open: boolean;
  names: readonly string[];
  onAnswer: (answer: ConflictAnswer) => void;
}) {
  const { t } = useTranslation();
  const title = conflictTitle(names);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onAnswer('cancel');
      }}
    >
      <DialogContent showCloseButton={false} data-testid="explorer-conflict-dialog">
        <DialogHeader>
          <DialogTitle className="break-all">{t(title.key, title.params)}</DialogTitle>
          <DialogDescription>{t('explorer.conflict.desc')}</DialogDescription>
        </DialogHeader>
        <ConflictNames names={names} />
        <DialogFooter>
          <Button
            variant="ghost"
            data-testid="explorer-conflict-cancel"
            onClick={() => onAnswer('cancel')}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="outline"
            data-testid="explorer-conflict-skip"
            onClick={() => onAnswer('skip')}
          >
            {t('explorer.conflict.skip')}
          </Button>
          <Button data-testid="explorer-conflict-replace" onClick={() => onAnswer('replace')}>
            {t('explorer.conflict.replace')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface ConflictPrompt {
  ask(names: string[]): Promise<ConflictAnswer>;
  element: ReactElement;
}

export function useConflictPrompt(): ConflictPrompt {
  // 关闭后保留名字：退场动画期间标题不该闪成空的
  const [state, setState] = useState<{ open: boolean; names: string[] }>({
    open: false,
    names: [],
  });
  const resolver = useRef<((answer: ConflictAnswer) => void) | null>(null);

  const settle = useCallback((answer: ConflictAnswer) => {
    const resolve = resolver.current;
    resolver.current = null;
    setState((prev) => (prev.open ? { ...prev, open: false } : prev));
    resolve?.(answer);
  }, []);

  const ask = useCallback((names: string[]) => {
    resolver.current?.('cancel');
    return new Promise<ConflictAnswer>((resolve) => {
      resolver.current = resolve;
      setState({ open: true, names });
    });
  }, []);

  // 宿主卸载时不留悬着的 Promise
  useEffect(
    () => () => {
      resolver.current?.('cancel');
      resolver.current = null;
    },
    []
  );

  const element = useMemo(
    () => <ExplorerConflictDialog open={state.open} names={state.names} onAnswer={settle} />,
    [state, settle]
  );

  return useMemo(() => ({ ask, element }), [ask, element]);
}
