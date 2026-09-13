// 详情框里的端口清单。
//
// 原来是三列表格，390px 下「用途 / 端口 / 状态」挤成三条竖字；改成一行一条、窄了就换行。
// TURN 控制口与紧邻的分配段合成一行（`coalesceTurnSpecs`）：两条挨着的 TURN 只是实现细节，
// 摆两行既占地方又让人以为有两个口要放行。

import { type PortSpec, coalesceTurnSpecs } from '@vibeterm/shared/net';
import { Button } from '@vibeterm/ui/button';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { type MeshPortReach, formatPortReach } from '../port-reach';

type ReachSpec = PortSpec & Pick<MeshPortReach, 'status' | 'code'>;

function toSpec(reach: MeshPortReach): ReachSpec {
  return { ...reach, requiredFor: 'lan-direct', required: true };
}

function toReach(spec: ReachSpec): MeshPortReach {
  const reach: MeshPortReach = { purpose: spec.purpose, proto: spec.proto, status: spec.status };
  if (spec.port !== undefined) reach.port = spec.port;
  if (spec.range) reach.range = spec.range;
  if (spec.code) reach.code = spec.code;
  return reach;
}

/** 合并相邻的 TURN 两条。`coalesceTurnSpecs` 是对象展开，探测状态会原样跟着合并后那条走。 */
export function coalescePortReaches(ports: MeshPortReach[]): MeshPortReach[] {
  return (coalesceTurnSpecs(ports.map(toSpec)) as ReachSpec[]).map(toReach);
}

/** 端口清单。单独导出：静态渲染测列表体，不跑「重新检测」。 */
export function NodePortsTable({
  nodeId,
  ports,
  busy = false,
  error,
  onRecheck,
}: {
  nodeId: string;
  ports: MeshPortReach[];
  busy?: boolean;
  error?: string | null;
  onRecheck?: () => void;
}) {
  const { t } = useTranslation();
  const rows = coalescePortReaches(ports);
  return (
    <div className="space-y-1.5" data-testid={`nodes-detail-ports-${nodeId}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{t('localMachine.ports.title')}</span>
        {onRecheck && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={onRecheck}
            data-testid={`nodes-ports-recheck-${nodeId}`}
          >
            {busy && <Loader2 className="animate-spin motion-reduce:animate-none" />}
            {t('nodes.ports.recheck')}
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-0.5 text-[11px]">
        {rows.map((item) => (
          <div
            key={`${item.purpose}:${formatPortReach(item)}`}
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5"
            data-testid={`nodes-detail-port-${item.purpose}`}
          >
            <span className="font-mono">{formatPortReach(item)}</span>
            <span className="text-muted-foreground">{t(`ports.purpose.${item.purpose}`)}</span>
            <span className="ml-auto" data-port-status={item.status}>
              {t(`nodes.ports.status.${item.status}`)}
            </span>
          </div>
        ))}
      </div>
      {error && (
        <p
          className="text-[11px] text-destructive"
          data-testid={`nodes-detail-ports-error-${nodeId}`}
        >
          {error}
        </p>
      )}
    </div>
  );
}
