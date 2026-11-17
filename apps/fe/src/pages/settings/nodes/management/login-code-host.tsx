// 「登录命令」对话框的唯一宿主：挂在应用外壳（侧栏之外），任何页面发出的打开请求都由它接收。
// 它在入口 chunk 里，必须保持极小：对话框本体（表单 / 结果 / 签发模块）全部动态加载，
// 首个请求到来前一个字节都不下载；与 rest 语言包并行加载，避免先渲染出裸 key。

import { withI18nRest } from '@/i18n/rest-prerequisite';
import { type ComponentType, useEffect, useState } from 'react';
import type { LoginCodeModuleLoader } from './login-code-controller';
import { closeLoginCodeRequest, useLoginCodeRequest } from './login-code-request';

interface DialogProps {
  selection: string;
  onClose: () => void;
  loadModule?: LoginCodeModuleLoader;
}

export const loadLoginCodeDialog = withI18nRest(
  async (): Promise<ComponentType<DialogProps>> =>
    (await import('./login-code-dialog')).LoginCodeDialog
);

// 加载成功后留一份：之后的请求直接同步挂载，不再闪一帧空白。
let loaded: ComponentType<DialogProps> | null = null;

/**
 * 整个应用只挂一份：同一请求绝不能同时驱动两个对话框。
 * 不用 React.lazy：它会把失败定死；这里失败就撤掉请求，用户再点一次即重新加载。
 */
export function LoginCodeDialogHost({
  loadModule,
  load = loadLoginCodeDialog,
}: {
  loadModule?: LoginCodeModuleLoader;
  /** 测试注入：替换对话框 chunk 的加载。 */
  load?: () => Promise<ComponentType<DialogProps>>;
}) {
  const request = useLoginCodeRequest();
  const [Dialog, setDialog] = useState<ComponentType<DialogProps> | null>(() => loaded);
  const requested = request !== null;

  useEffect(() => {
    if (!requested || Dialog) return;
    let cancelled = false;
    load().then(
      (component) => {
        loaded = component;
        if (!cancelled) setDialog(() => component);
      },
      () => {
        if (!cancelled) closeLoginCodeRequest();
      }
    );
    return () => {
      cancelled = true;
    };
  }, [requested, Dialog, load]);

  if (!request || !Dialog) return null;
  return (
    <Dialog
      key={request.seq}
      selection={request.selection}
      onClose={closeLoginCodeRequest}
      loadModule={loadModule}
    />
  );
}
