// 令牌 / 分享列表里的「签发节点」：只有经其他节点签发的才点名，本机签发不显示。

import { getMeshNodesState, subscribeMeshNodes } from '@/node/mesh-nodes';
import { issuerNodeName } from '@/node/node-names';
import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

export function IssuedVia({
  issuedVia,
  className,
  testId,
}: { issuedVia: string; className?: string; testId: string }) {
  const { t } = useTranslation();
  useSyncExternalStore(subscribeMeshNodes, getMeshNodesState, getMeshNodesState);
  const name = issuerNodeName(issuedVia);
  if (!name) return null;
  return (
    <span className={className} title={issuedVia} data-testid={testId}>
      {t('common.issuedVia', { name })}
    </span>
  );
}
