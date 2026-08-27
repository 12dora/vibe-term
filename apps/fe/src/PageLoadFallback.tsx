import { Button } from '@tmex/ui/button';
import { RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function PageLoadFallback({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();

  return (
    <div
      className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-6 text-center"
      role="alert"
      data-testid="page-load-error"
    >
      <p className="text-sm font-medium">{t('common.pageLoadFailed')}</p>
      <p className="text-muted-foreground text-xs">{t('common.pageLoadFailedHint')}</p>
      <Button variant="outline" size="sm" onClick={onRetry} data-testid="page-load-retry">
        <RotateCw className="h-4 w-4" />
        {t('common.retry')}
      </Button>
    </div>
  );
}
