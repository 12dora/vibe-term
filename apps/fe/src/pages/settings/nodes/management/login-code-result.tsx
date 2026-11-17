// 「登录命令」第二步：命令、有效期倒计时、各节点的使用状态。纯展示，状态来自控制器。

import type { LoginCodeNodeState } from '@/auth/login-code-issue';
import { CopyableCode } from '@/pages/settings/nodes/copy-feedback';
import { LOGIN_CODE_TTL_MS } from '@vibeterm/shared/auth';
import { Badge } from '@vibeterm/ui/badge';
import { useTranslation } from 'react-i18next';
import type { LoginCodeResultState } from './login-code-controller';
import { formatCountdown, loginCodeReasonText } from './login-code-text';

const NS = 'nodes.loginCode';
const TTL_MINUTES = Math.round(LOGIN_CODE_TTL_MS / 60_000);

type ResultRow =
  | { meshId: string; name: string; kind: 'state'; state: Exclude<LoginCodeNodeState, 'unknown'> }
  | { meshId: string; name: string; kind: 'reason'; code: string };

/** 结果行：成功签发的按轮询状态，失败与被跳过的给出原因。已过期时仍待使用的显示为已过期。 */
export function buildResultRows(result: LoginCodeResultState, expired: boolean): ResultRow[] {
  const rows: ResultRow[] = [];
  for (const node of result.nodes) {
    if (!node.ok) {
      rows.push({ meshId: node.meshId, name: node.name, kind: 'reason', code: node.code });
      continue;
    }
    const known = result.states[node.meshId];
    const state = known && known !== 'unknown' ? known : 'pending';
    rows.push({
      meshId: node.meshId,
      name: node.name,
      kind: 'state',
      state: state === 'pending' && expired ? 'expired' : state,
    });
  }
  for (const skipped of result.skipped) {
    rows.push({ meshId: skipped.meshId, name: skipped.name, kind: 'reason', code: skipped.reason });
  }
  return rows;
}

function StateBadge({ state }: { state: Exclude<LoginCodeNodeState, 'unknown'> }) {
  const { t } = useTranslation();
  const variant =
    state === 'used'
      ? 'default'
      : state === 'revoked'
        ? 'destructive'
        : state === 'expired'
          ? 'ghost'
          : 'secondary';
  return (
    <Badge variant={variant} data-testid={`login-code-status-${state}`}>
      {t(`${NS}.status.${state}`)}
    </Badge>
  );
}

function NodeRowView({ row }: { row: ResultRow }) {
  const { t } = useTranslation();
  return (
    <li
      className="flex items-center justify-between gap-3 py-1.5 text-sm"
      data-testid={`login-code-node-${row.meshId}`}
    >
      <span className="min-w-0 truncate">{row.name}</span>
      {row.kind === 'state' ? (
        <StateBadge state={row.state} />
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground">
          {loginCodeReasonText(t, row.code)}
        </span>
      )}
    </li>
  );
}

export interface LoginCodeResultViewProps {
  result: LoginCodeResultState;
  now: number;
}

export function LoginCodeResultView({ result, now }: LoginCodeResultViewProps) {
  const { t } = useTranslation();
  const remaining = result.handle.expiresAt - now;
  const expired = remaining <= 0;
  const rows = buildResultRows(result, expired);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="login-code-result">
      <CopyableCode value={result.handle.command} testId="login-code-command" />
      <p className="flex flex-wrap items-center justify-between gap-x-3 text-xs text-muted-foreground">
        <span>{t(`${NS}.result.validity`, { minutes: TTL_MINUTES })}</span>
        <span className="tabular-nums" data-testid="login-code-remaining">
          {expired
            ? t(`${NS}.result.expired`)
            : t(`${NS}.result.remaining`, { time: formatCountdown(remaining) })}
        </span>
      </p>
      <ul
        className="max-h-56 divide-y divide-border/60 overflow-y-auto"
        data-testid="login-code-nodes"
      >
        {rows.map((row) => (
          <NodeRowView key={`${row.kind}-${row.meshId}`} row={row} />
        ))}
      </ul>
    </div>
  );
}
