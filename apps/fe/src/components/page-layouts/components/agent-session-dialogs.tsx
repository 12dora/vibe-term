// 会话重命名/删除对话框；挂在设备树根部，状态来自 SidebarAgentSessionsProvider。

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@tmex/ui/alert-dialog';
import { Button } from '@tmex/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@tmex/ui/dialog';
import { Input } from '@tmex/ui/input';
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

      <AlertDialog
        open={sessionDeleteCandidate !== null}
        onOpenChange={(open) => !open && closeDeleteDialog()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10">
              <X className="h-5 w-5 text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('agent.session.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('agent.session.deleteDesc', { title: sessionDeleteCandidate?.title ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!sessionDeleteCandidate}
              onClick={confirmDeleteSession}
              data-testid="agent-session-delete-confirm"
            >
              {t('agent.session.deleteConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
