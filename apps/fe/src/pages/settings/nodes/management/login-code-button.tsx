// 节点卡头的「登录命令」入口：只发打开请求，对话框由外壳级 `LoginCodeDialogHost` 承载。

import { Button } from '@vibeterm/ui/button';
import { SquareTerminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { requestLoginCode } from './login-code-request';

export function LoginCodeButton() {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => requestLoginCode('all')}
      data-testid="nodes-login-code"
    >
      <SquareTerminal />
      {t('nodes.loginCode.title')}
    </Button>
  );
}
