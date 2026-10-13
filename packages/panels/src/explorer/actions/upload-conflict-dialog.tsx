// 上传同名冲突的询问框：取消 / 跳过 / 替换。`useUploadConflictPrompt` 把它包成 Promise，
// 同时来的多次询问排队逐个弹。

import { ConfirmDialog } from '@vibeterm/ui/confirm-dialog';
import type { TFunction } from 'i18next';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FILE_DELETE_LISTED_NAMES } from '../../files/ops';
import type { UploadConflictChoice } from './upload-conflicts';

export type { UploadConflictChoice };

export interface UploadConflictDialogProps {
  open: boolean;
  /** 会被覆盖的项目（展示用名称） */
  names: readonly string[];
  /** 名单里有没能确认是否已存在的项目：标题不再断言「已存在」 */
  uncertain?: boolean;
  onChoose(choice: UploadConflictChoice): void;
}

function ConflictNameList({ names }: { names: readonly string[] }) {
  const { t } = useTranslation();
  const listed = names.slice(0, FILE_DELETE_LISTED_NAMES);
  const rest = names.length - listed.length;
  return (
    <ul className="text-sm" data-testid="explorer-upload-conflict-names">
      {listed.map((name) => (
        <li key={name} className="truncate" title={name}>
          {name}
        </li>
      ))}
      {rest > 0 ? (
        <li className="text-muted-foreground">{t('files.ops.deleteMore', { count: rest })}</li>
      ) : null}
    </ul>
  );
}

function conflictTitleOf(t: TFunction, names: readonly string[], uncertain: boolean): string {
  // 有没查清存在性的项目时不能断言「已存在」
  if (uncertain) return t('explorer.conflict.titleUnknown');
  return names.length === 1
    ? t('explorer.conflict.titleOne', { name: names[0] })
    : t('explorer.conflict.titleMany', { count: names.length });
}

export function UploadConflictDialog({
  open,
  names,
  uncertain = false,
  onChoose,
}: UploadConflictDialogProps) {
  const { t } = useTranslation();
  const title = conflictTitleOf(t, names, uncertain);
  return (
    <ConfirmDialog
      open={open}
      title={title}
      cancelLabel={t('common.cancel')}
      confirmLabel={t('explorer.conflict.replace')}
      onConfirm={() => onChoose('replace')}
      // Esc / 点外面等同取消：什么都不传
      onOpenChange={(next) => {
        if (!next) onChoose('cancel');
      }}
      extra={names.length > 1 || uncertain ? <ConflictNameList names={names} /> : undefined}
      testId="explorer-upload-conflict"
      actions={[
        {
          label: t('common.cancel'),
          onClick: () => onChoose('cancel'),
          variant: 'outline',
          testId: 'explorer-upload-conflict-cancel',
        },
        {
          label: t('explorer.conflict.skip'),
          onClick: () => onChoose('skip'),
          variant: 'outline',
          testId: 'explorer-upload-conflict-skip',
        },
        {
          label: t('explorer.conflict.replace'),
          onClick: () => onChoose('replace'),
          variant: 'destructive',
          testId: 'explorer-upload-conflict-replace',
        },
      ]}
    >
      {t('explorer.conflict.desc')}
    </ConfirmDialog>
  );
}

interface PendingPrompt {
  names: readonly string[];
  uncertain: boolean;
  resolve(choice: UploadConflictChoice): void;
}

export interface UploadConflictPrompt {
  /** `uncertain`：名单里有没能确认是否已存在的项目 */
  ask(names: readonly string[], uncertain?: boolean): Promise<UploadConflictChoice>;
  element: ReactElement;
}

const NO_NAMES: readonly string[] = [];

export function useUploadConflictPrompt(): UploadConflictPrompt {
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const pendingRef = useRef<PendingPrompt | null>(null);
  const queueTailRef = useRef<Promise<unknown>>(Promise.resolve());
  const unmountedRef = useRef(false);
  // 关闭动画期间沿用上一次的名单，避免标题闪成「0 个」
  const shownNamesRef = useRef(NO_NAMES);
  const shownUncertainRef = useRef(false);
  if (pending) {
    shownNamesRef.current = pending.names;
    shownUncertainRef.current = pending.uncertain;
  }

  const show = useCallback((names: readonly string[], uncertain: boolean) => {
    return new Promise<UploadConflictChoice>((resolve) => {
      // 组件已卸载就没人能回答了：按取消处理，绝不替用户覆盖
      if (unmountedRef.current) {
        resolve('cancel');
        return;
      }
      const prompt: PendingPrompt = { names, uncertain, resolve };
      pendingRef.current = prompt;
      setPending(prompt);
    });
  }, []);

  const ask = useCallback(
    (names: readonly string[], uncertain = false) => {
      const answer = queueTailRef.current.then(() => show(names, uncertain));
      queueTailRef.current = answer;
      return answer;
    },
    [show]
  );

  const choose = useCallback((choice: UploadConflictChoice) => {
    const current = pendingRef.current;
    if (!current) return;
    pendingRef.current = null;
    setPending(null);
    current.resolve(choice);
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      pendingRef.current?.resolve('cancel');
      pendingRef.current = null;
    };
  }, []);

  const element = useMemo(
    () => (
      <UploadConflictDialog
        open={pending !== null}
        names={shownNamesRef.current}
        uncertain={shownUncertainRef.current}
        onChoose={choose}
      />
    ),
    [pending, choose]
  );

  return useMemo(() => ({ ask, element }), [ask, element]);
}
