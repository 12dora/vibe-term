// 私有 CA 的各端安装说明。用原生 <details> 而不是 JS 折叠：内容是纯文本，无需水合即可展开。

import { useTranslation } from 'react-i18next';

const PLATFORMS = ['macos', 'ios', 'windows', 'android', 'linux'] as const;

export function CaInstallGuide() {
  const { t } = useTranslation();
  return (
    <details className="rounded-lg bg-muted/40 p-2" data-testid="https-ca-guide">
      <summary className="cursor-pointer text-xs font-medium">
        {t('nodes.https.selfsigned.guide.title')}
      </summary>
      <div className="space-y-2 pt-2">
        <p className="text-xs text-muted-foreground">{t('nodes.https.selfsigned.guide.intro')}</p>
        {PLATFORMS.map((platform) => (
          <div key={platform} className="space-y-0.5" data-testid={`https-ca-guide-${platform}`}>
            <p className="text-xs font-medium">
              {t(`nodes.https.selfsigned.guide.${platform}.title`)}
            </p>
            <p className="whitespace-pre-line text-xs text-muted-foreground">
              {t(`nodes.https.selfsigned.guide.${platform}.steps`)}
            </p>
          </div>
        ))}
      </div>
    </details>
  );
}
