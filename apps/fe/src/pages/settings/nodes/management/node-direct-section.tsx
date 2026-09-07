// 节点详情里的直连插件那一段：状态行 + 一枚两态按钮 + 重启提醒 + 删除前的二次确认。
//
// 与名称 / 域名访问不同，这一段不进「保存」——装 / 删是立即生效的动作，且要等重启才真的生效，
// 混进脏检查只会让「保存」这个词同时表达两种时序。

import type { NodeRow } from '@/node/mesh-nodes';
import { Button } from '@vibeterm/ui/button';
import { Download, Loader2, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DangerConfirmDialog } from '../../components/danger-confirm-dialog';
import { Notice, NoticeAction } from '../card-parts';
import {
  type DirectPluginAction,
  type DirectPluginUi,
  directPluginButton,
  directPluginNotice,
  directPluginStatusText,
} from './node-direct-plugin';

export interface NodeDirectSectionProps {
  row: NodeRow;
  ui: DirectPluginUi;
  onAction: (action: DirectPluginAction) => void;
  onRestart: () => void;
}

/** 正文那一段。单独导出：Dialog 走 portal，静态渲染只看得到这一块。 */
export function NodeDirectBody({ row, ui, onAction, onRestart }: NodeDirectSectionProps) {
  const { t } = useTranslation();
  const button = directPluginButton(ui);
  const notice = directPluginNotice(ui, t);
  const Icon = button.destructive ? Trash2 : Download;

  return (
    <div className="flex flex-col gap-2" data-testid={`nodes-detail-direct-${row.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <span className="block text-xs font-medium">{t('nodes.detail.direct')}</span>
          <p
            className="text-[11px] text-muted-foreground"
            data-testid={`nodes-detail-direct-status-${row.id}`}
            data-direct-state={ui.load.kind}
          >
            {directPluginStatusText(ui.load, t)}
          </p>
        </div>
        <Button
          type="button"
          size="xs"
          variant={button.destructive ? 'ghost' : 'outline'}
          disabled={button.disabled}
          onClick={() => onAction(button.action)}
          data-testid={`nodes-detail-direct-action-${row.id}`}
          data-direct-action={button.action}
        >
          {ui.pending === button.action ? (
            <Loader2 className="animate-spin motion-reduce:animate-none" />
          ) : (
            <Icon />
          )}
          {t(button.labelKey)}
        </Button>
      </div>

      {notice && (
        <Notice
          tone="muted"
          spinner={!notice.restartable}
          testId={`nodes-detail-direct-notice-${row.id}`}
          action={
            notice.restartable ? (
              <NoticeAction
                label={t('nodes.detail.directRestartNow')}
                testId={`nodes-detail-direct-restart-${row.id}`}
                onClick={onRestart}
              />
            ) : undefined
          }
        >
          {notice.text}
        </Notice>
      )}

      {ui.error && (
        <p
          className="text-[11px] text-destructive"
          data-testid={`nodes-detail-direct-error-${row.id}`}
        >
          {ui.error}
        </p>
      )}
    </div>
  );
}

export function NodeDirectRemoveConfirm({
  open,
  onConfirm,
  onCancel,
  testId,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testId: string;
}) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <DangerConfirmDialog
      open
      title={t('nodes.machine.directRemoveConfirm.title')}
      cancelLabel={t('nodes.machine.directRemoveConfirm.cancel')}
      confirmLabel={t('nodes.machine.directRemoveConfirm.confirm')}
      onCancel={onCancel}
      onConfirm={onConfirm}
      testId={testId}
      confirmTestId={`${testId}-ok`}
    >
      {t('nodes.machine.directRemoveConfirm.description')}
    </DangerConfirmDialog>
  );
}
