import { Loader2, QrCode, RefreshCw } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useTranslation } from 'react-i18next';

import { Button } from '@tmex/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tmex/ui/dialog';

import { useWeixinAccountLogin } from './use-weixin-account-login';
import type { WeixinLoginPhase } from './weixin-login-flow';

interface WeixinAccountLoginModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  accountName: string;
}
interface LoginQrcodeProps {
  accountId: string;
  phase: WeixinLoginPhase;
  qrcodeUrl: string | null;
}

function LoginQrcode({ accountId, phase, qrcodeUrl }: LoginQrcodeProps) {
  if (phase === 'starting') {
    return <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />;
  }
  if (!qrcodeUrl) return <QrCode className="h-10 w-10 text-muted-foreground" />;
  return (
    <QRCodeSVG
      value={qrcodeUrl}
      size={208}
      marginSize={3}
      data-testid={`weixin-account-login-qrcode-${accountId}`}
    />
  );
}

export function WeixinAccountLoginModal({
  open,
  onOpenChange,
  accountId,
  accountName,
}: WeixinAccountLoginModalProps) {
  const { t } = useTranslation();
  const { qrcodeUrl, phase, statusMessage, restart } = useWeixinAccountLogin({
    open,
    accountId,
    onOpenChange,
  });
  const canRefresh = phase === 'expired' || phase === 'error';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-sm"
        data-testid={`weixin-account-login-modal-${accountId}`}
      >
        <DialogHeader>
          <DialogTitle>{t('weixin.scanToLogin')}</DialogTitle>
          <DialogDescription>{accountName}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-2">
          <div className="flex h-56 w-56 items-center justify-center rounded-lg border border-border bg-white">
            <LoginQrcode accountId={accountId} phase={phase} qrcodeUrl={qrcodeUrl} />
          </div>
          {statusMessage && (
            <p
              className="text-center text-sm font-medium"
              data-testid={`weixin-account-login-status-${accountId}`}
            >
              {statusMessage}
            </p>
          )}
        </div>
        <DialogFooter>
          {canRefresh && (
            <Button
              variant="secondary"
              data-testid="weixin-account-login-refresh"
              onClick={restart}
            >
              <RefreshCw className="h-4 w-4" />
              {t('weixin.refreshQrcode')}
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('weixin.closeLogin')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
