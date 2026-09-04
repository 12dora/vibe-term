import { useTranslation } from 'react-i18next';

interface ChatCommandsBadgeProps {
  /** i18n 命名空间：telegram / weixin */
  namespace: 'telegram' | 'weixin';
  allowCommands: boolean;
  testId: string;
}

/** 开启「允许聊天指令」的 bot / 账号在列表里挂个提示徽标。 */
export function ChatCommandsBadge({ namespace, allowCommands, testId }: ChatCommandsBadgeProps) {
  const { t } = useTranslation();

  if (!allowCommands) {
    return null;
  }

  return (
    <span
      className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300"
      title={t(`${namespace}.allowCommandsHelp`)}
      data-testid={testId}
    >
      {t(`${namespace}.commandsBadge`)}
    </span>
  );
}
