// 会话重命名/删除对话框；挂在设备树根部，状态来自 SidebarAgentSessionsProvider。

import { Button } from '@vibeterm/ui/button';
import { ConfirmDialog } from '@vibeterm/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibeterm/ui/dialog';
import { Input } from '@vibeterm/ui/input';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSidebarAgentDialogs } from './use-sidebar-agent-sessions';

export function AgentSessionDialogs() {
  const { t } = useTranslation();
  const {
    sessionRenameCandidate,
    sessionRenameValue,
    setSessionRenameValue,
    closeRenameDialog,
    confirmRenameSession,
    sessionDeleteCandidate,
    closeDeleteDialog,
    confirmDeleteSession,
  } = useSidebarAgentDialogs();

  return (
    <>
      <Dialog
        open={sessionRenameCandidate !== null}
        onOpenChange={(open) => !open && closeRenameDialog()}
      >
        <DialogContent data-testid="agent-session-rename-dialog">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              confirmRenameSession();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('agent.session.renameTitle')}</DialogTitle>
            </DialogHeader>
            <div className="py-4">
              <Input
                autoFocus
                maxLength={120}
                value={sessionRenameValue}
                onChange={(e) => setSessionRenameValue(e.target.value)}
                placeholder={t('agent.session.renamePlaceholder')}
                data-testid="agent-session-rename-input"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeRenameDialog}>
                {t('agent.session.cancel')}
              </Button>
              <Button
                type="submit"
                disabled={!sessionRenameValue.trim()}
                data-testid="agent-session-rename-save"
              >
                {t('agent.session.save')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={sessionDeleteCandidate !== null}
        onOpenChange={(open) => {
          if (!open) closeDeleteDialog();
        }}
        title={t('agent.session.deleteTitle')}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('agent.session.deleteConfirm')}
        onCancel={closeDeleteDialog}
        onConfirm={confirmDeleteSession}
        confirmDisabled={!sessionDeleteCandidate}
        confirmTestId="agent-session-delete-confirm"
        media={<X className="h-5 w-5 text-destructive" />}
      >
        {t('agent.session.deleteDesc', { title: sessionDeleteCandidate?.title ?? '' })}
      </ConfirmDialog>
    </>
  );
}
