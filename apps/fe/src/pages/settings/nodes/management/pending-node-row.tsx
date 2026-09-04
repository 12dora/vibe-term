// 节点表里的「待批准」行：Hub 已发出证书、本地密钥日志还没有 `admit-node` 的那一台。
//
// 它还不是 mesh 成员（`/api/mesh/nodes` 里没有它），因此没有 peer link、没有版本、
// 也没有可吊销的证书：整行除「批准加入」外一律禁用。

import type { NodeRow } from '@/node/mesh-nodes';
import { Button } from '@tmex/ui/button';
import { Checkbox } from '@tmex/ui/checkbox';
import { Check, Ellipsis, Loader2, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { stickyActionColumn } from '../../components/wide-table';
import { Td, rowBlockedHint } from './row-cells';
import type { NodeActionDeps } from './types';
import { useAdmitNode } from './use-node-row-actions';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * 待批准行：Hub 已发出证书，本地密钥日志还没有 `admit-node`——它还不是 mesh 成员。
 * 因此没有 peer link、没有版本、也没有可吊销的证书，除「批准加入」外一律禁用；
 * 勾选框同样禁用，批量升级 / 移除都碰不到它。
 */
export function PendingNodeRow({ row, ...deps }: { row: NodeRow } & NodeActionDeps) {
  const { t } = useTranslation();
  const writable = deps.hubOnline && deps.hubWritable;
  const blocked = writable ? t('nodes.admit.blocked') : rowBlockedHint(t, deps);

  return (
    <tr className="border-b border-border/60 last:border-0" data-testid={`nodes-row-${row.id}`}>
      <td className="px-2 py-2 align-middle">
        <Checkbox checked={false} disabled aria-label={row.name} />
      </td>
      <Td>
        <span className="truncate font-medium">{row.name}</span>
      </Td>
      <Td>
        <span
          className="text-amber-600 dark:text-amber-400"
          data-testid={`nodes-status-${row.id}`}
          data-admission="pending"
        >
          {t('nodes.status.pending')}
        </span>
      </Td>
      <Td>
        <span data-testid={`nodes-reach-${row.id}`}>—</span>
      </Td>
      <Td>—</Td>
      <Td>{row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString() : '—'}</Td>
      <Td>{t('common.no')}</Td>
      <Td>—</Td>
      <Td>—</Td>
      <Td className={stickyActionColumn}>
        <div className="flex items-start gap-1">
          <AdmitButton row={row} writable={writable} {...deps} />
          <Button type="button" size="xs" variant="outline" disabled title={blocked}>
            <Ellipsis />
            {t('nodes.actions.more')}
          </Button>
          <Button type="button" size="xs" variant="destructive" disabled title={blocked}>
            <ShieldAlert />
            {t('nodes.actions.revoke')}
          </Button>
        </div>
      </Td>
    </tr>
  );
}

/**
 * 「批准加入」：签一条 `admit-node`。Hub 不收写入、或材料不全时禁用并说明原因。
 *
 * 原因**必须可见**：禁用按钮既聚焦不了（`focusableWhenDisabled=false`）也接不住悬浮
 * （`disabled:pointer-events-none`），只挂 `title` 等于谁都读不到。因此在按钮下方渲染一行
 * 弱化说明，并用 `aria-describedby` 关联给屏幕阅读器。
 */
function AdmitButton({
  row,
  writable,
  ...deps
}: { row: NodeRow; writable: boolean } & NodeActionDeps) {
  const { t } = useTranslation();
  const { busy, admit } = useAdmitNode(row, deps);
  const label = t('nodes.actions.admit');
  const blocked = admitBlockedHint(t, row, writable, deps);
  const hintId = blocked === null ? undefined : `nodes-admit-hint-${row.id}`;

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        size="xs"
        disabled={busy || blocked !== null}
        title={blocked ?? label}
        aria-describedby={hintId}
        onClick={() => void admit()}
        data-testid={`nodes-admit-${row.id}`}
      >
        {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Check />}
        {label}
      </Button>
      {blocked !== null && (
        <span
          id={hintId}
          data-testid="pending-node-admit-hint"
          className="max-w-56 text-[11px] leading-snug text-muted-foreground"
        >
          {blocked}
        </span>
      )}
    </div>
  );
}

function admitBlockedHint(
  t: Translate,
  row: NodeRow,
  writable: boolean,
  deps: Pick<NodeActionDeps, 'hubWritable' | 'blockedHint'>
): string | null {
  if (!writable) return rowBlockedHint(t, deps);
  return row.admitMaterial ? null : t('nodes.admit.unavailable');
}
