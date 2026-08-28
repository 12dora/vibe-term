import type { WatchRuleDto } from '@tmex/shared';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@tmex/ui/dialog';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type WatchQueryStatus, useWatchRuleMutations, useWatchRules } from './use-watch-rules';
import { WatchRuleForm } from './watch-rule-form';
import { WatchRuleList } from './watch-rule-list';
import { WatchRuleStateView } from './watch-rule-state-view';

type DialogView =
  | { mode: 'list' }
  | { mode: 'form'; rule: WatchRuleDto | null }
  | { mode: 'state'; rule: WatchRuleDto };

interface WatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceId: string;
  paneId: string;
}

function dialogTitleKey(view: DialogView): string {
  if (view.mode === 'list') {
    return 'watch.title';
  }
  if (view.mode === 'state') {
    return 'watch.state.title';
  }
  return view.rule ? 'watch.form.editTitle' : 'watch.form.createTitle';
}

interface DialogUiState {
  view: DialogView;
  setView: (view: DialogView) => void;
  deleteCandidate: WatchRuleDto | null;
  setDeleteCandidate: (rule: WatchRuleDto | null) => void;
  showNotifBanner: boolean;
  dismissNotifBanner: () => void;
  handleSaved: (created: boolean) => void;
}

/** 关闭对话框时把视图与临时选择复位，下次打开总是从列表开始 */
function useDialogUiState(open: boolean, refreshRules: () => void): DialogUiState {
  const [view, setView] = useState<DialogView>({ mode: 'list' });
  const [deleteCandidate, setDeleteCandidate] = useState<WatchRuleDto | null>(null);
  const [showNotifBanner, setShowNotifBanner] = useState(false);

  useEffect(() => {
    if (!open) {
      setView({ mode: 'list' });
      setDeleteCandidate(null);
      setShowNotifBanner(false);
    }
  }, [open]);

  return {
    view,
    setView,
    deleteCandidate,
    setDeleteCandidate,
    showNotifBanner,
    dismissNotifBanner: () => setShowNotifBanner(false),
    handleSaved: (created) => {
      refreshRules();
      setView({ mode: 'list' });
      if (created && typeof Notification !== 'undefined' && Notification.permission === 'default') {
        setShowNotifBanner(true);
      }
    },
  };
}

export function WatchDialog({ open, onOpenChange, deviceId, paneId }: WatchDialogProps) {
  const { t } = useTranslation();
  const { rules, status, retry, refresh } = useWatchRules(deviceId, paneId, open);
  const mutations = useWatchRuleMutations();
  const ui = useDialogUiState(open, refresh);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="sm:max-w-lg max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)]"
          data-testid="watch-dialog"
        >
          <DialogHeader>
            <DialogTitle>{t(dialogTitleKey(ui.view))}</DialogTitle>
            <DialogDescription>
              {ui.view.mode === 'list' ? t('watch.dialogDesc') : null}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 overflow-y-auto pr-1">
            <WatchDialogBody
              view={ui.view}
              deviceId={deviceId}
              paneId={paneId}
              rules={rules}
              status={status}
              showNotifBanner={ui.showNotifBanner}
              onDismissNotifBanner={ui.dismissNotifBanner}
              onRetry={retry}
              onToggle={mutations.toggle}
              onDelete={ui.setDeleteCandidate}
              onChangeView={ui.setView}
              onSaved={ui.handleSaved}
            />
          </div>
        </DialogContent>
      </Dialog>

      <DeleteRuleDialog
        rule={ui.deleteCandidate}
        onCancel={() => ui.setDeleteCandidate(null)}
        onConfirm={(rule) => {
          mutations.remove(rule);
          ui.setDeleteCandidate(null);
        }}
      />
    </>
  );
}

interface WatchDialogBodyProps {
  view: DialogView;
  deviceId: string;
  paneId: string;
  rules: WatchRuleDto[];
  status: WatchQueryStatus;
  showNotifBanner: boolean;
  onDismissNotifBanner: () => void;
  onRetry: () => void;
  onToggle: (rule: WatchRuleDto, enabled: boolean) => void;
  onDelete: (rule: WatchRuleDto) => void;
  onChangeView: (view: DialogView) => void;
  onSaved: (created: boolean) => void;
}

function WatchDialogBody(props: WatchDialogBodyProps) {
  const { view, onChangeView } = props;
  const backToList = (): void => onChangeView({ mode: 'list' });

  if (view.mode === 'form') {
    return (
      <WatchRuleForm
        deviceId={props.deviceId}
        paneId={props.paneId}
        rule={view.rule}
        onSaved={props.onSaved}
        onCancel={backToList}
      />
    );
  }

  if (view.mode === 'state') {
    return <WatchRuleStateView rule={view.rule} onBack={backToList} />;
  }

  return (
    <WatchRuleList
      rules={props.rules}
      status={props.status}
      showNotifBanner={props.showNotifBanner}
      onDismissNotifBanner={props.onDismissNotifBanner}
      onRetry={props.onRetry}
      onToggle={props.onToggle}
      onEdit={(rule) => onChangeView({ mode: 'form', rule })}
      onViewState={(rule) => onChangeView({ mode: 'state', rule })}
      onDelete={props.onDelete}
      onAdd={() => onChangeView({ mode: 'form', rule: null })}
    />
  );
}

interface DeleteRuleDialogProps {
  rule: WatchRuleDto | null;
  onCancel: () => void;
  onConfirm: (rule: WatchRuleDto) => void;
}

function DeleteRuleDialog({ rule, onCancel, onConfirm }: DeleteRuleDialogProps) {
  const { t } = useTranslation();

  return (
    <AlertDialog open={rule !== null} onOpenChange={(nextOpen) => !nextOpen && onCancel()}>
      <AlertDialogContent data-testid="watch-rule-delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('watch.rules.deleteTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('watch.rules.deleteDesc', { name: rule?.name ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            data-testid="watch-rule-delete-confirm"
            onClick={() => rule && onConfirm(rule)}
          >
            {t('watch.rules.deleteConfirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
