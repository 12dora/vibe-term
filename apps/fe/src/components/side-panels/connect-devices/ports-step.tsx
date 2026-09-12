// 接入向导的「放行端口」步：清单优先用本机 `/api/local/status.portPlan`，
// 旧节点不下发时按路径角色套默认计划。

import { asPortRole, portPlanOrFallback } from '@/pages/settings/nodes/port-reach';
import { type PortRole, type PortSpec, formatPortSpec } from '@vibeterm/shared/net';
import { useTranslation } from 'react-i18next';
import { GuideStep } from './guide-step';

export function PortsStep({
  index,
  fallbackRole,
  portPlan,
}: {
  index: number;
  fallbackRole: PortRole;
  portPlan?: PortSpec[] | null;
}) {
  const { t } = useTranslation();
  const specs = portPlanOrFallback(portPlan ?? undefined, asPortRole(fallbackRole, fallbackRole));
  return (
    <GuideStep
      index={index}
      testId="connect-step-ports"
      title={t('connectDevices.ports.title')}
      description={t('connectDevices.ports.desc')}
    >
      {specs.length > 0 && (
        <ul className="space-y-1" data-testid="connect-ports-list">
          {specs.map((spec) => (
            <li
              key={`${spec.purpose}:${formatPortSpec(spec)}`}
              className="flex items-baseline gap-2 text-xs"
              data-testid={`connect-port-${spec.purpose}`}
            >
              <code className="font-mono">{formatPortSpec(spec)}</code>
              <span className="text-muted-foreground">{t(`ports.purpose.${spec.purpose}`)}</span>
            </li>
          ))}
        </ul>
      )}
    </GuideStep>
  );
}
