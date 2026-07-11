// 终端通知 toast 的文案组装（i18n 经 t 注入，宿主传入自己的翻译实例）

export type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

function buildPaneLabel(data: Record<string, unknown>, t: TranslateFn): string {
  if (typeof data.paneTitle === 'string' && data.paneTitle) {
    return data.paneTitle;
  }
  if (typeof data.paneCurrentCommand === 'string' && data.paneCurrentCommand) {
    return data.paneCurrentCommand;
  }
  if (typeof data.paneIndex === 'number') {
    return t('terminal.paneTitle', { index: data.paneIndex });
  }
  if (typeof data.paneId === 'string' && data.paneId) {
    return t('terminal.paneTitle', { index: data.paneId });
  }
  return '';
}

export function buildPaneLocationLabel(data: Record<string, unknown>, t: TranslateFn): string {
  const windowLabel =
    typeof data.windowIndex === 'number'
      ? String(data.windowIndex)
      : typeof data.windowId === 'string' && data.windowId
        ? data.windowId
        : '';
  const paneLabel = buildPaneLabel(data, t);

  if (windowLabel && paneLabel) {
    return t('terminal.bellDescriptionWithTitle', { window: windowLabel, paneLabel });
  }
  if (windowLabel) {
    return `${t('notification.window')} ${windowLabel}`;
  }
  if (paneLabel) {
    return paneLabel;
  }
  return '';
}

export function formatTerminalNotificationToast(
  data: Record<string, unknown>,
  t: TranslateFn
): {
  title: string;
  description: string;
} {
  const title =
    typeof data.title === 'string' && data.title
      ? data.title
      : t('terminal.notificationFallbackTitle');
  const location = buildPaneLocationLabel(data, t);
  const detail =
    typeof data.body === 'string' && data.body
      ? data.body
      : typeof data.source === 'string' && data.source
        ? t('terminal.notificationSourceLabel', { source: data.source })
        : t('terminal.notificationFallbackDetail');

  return {
    title,
    description: location ? `${location}\n${detail}` : detail,
  };
}
