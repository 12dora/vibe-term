// 「这次写给谁、哪几台被跳过、为什么」：卸载确认框与批量内存限额对话框共用这一段清单。
//
// 两边的结构完全一样，只差 i18n 命名空间与 testid 前缀，所以按前缀参数化成一个组件。

import type { NodeRow } from '@/node/mesh-nodes';
import { useTranslation } from 'react-i18next';

export interface PlanRowsProps<Reason extends string> {
  plan: { targets: NodeRow[]; skipped: Array<{ row: NodeRow; reason: Reason }> };
  /** 跳过原因 → i18n 键。 */
  skipKey: Record<Reason, string>;
  /** i18n 命名空间，取 `<ns>.targets` / `<ns>.skipped` / `<ns>.noTargets` 三个键。 */
  ns: string;
  /** testid 前缀，拼成 `<prefix>-target-<id>` / `<prefix>-skip-<id>` / `<prefix>-none`。 */
  testIdPrefix: string;
}

export function PlanRows<Reason extends string>({
  plan,
  skipKey,
  ns,
  testIdPrefix,
}: PlanRowsProps<Reason>) {
  const { t } = useTranslation();
  return (
    <>
      {plan.targets.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground">
            {t(`${ns}.targets`, { count: plan.targets.length })}
          </p>
          <ul className="flex flex-col gap-0.5">
            {plan.targets.map((row) => (
              <li
                key={row.id}
                className="truncate font-medium"
                data-testid={`${testIdPrefix}-target-${row.id}`}
              >
                {row.name}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-destructive" data-testid={`${testIdPrefix}-none`}>
          {t(`${ns}.noTargets`)}
        </p>
      )}

      {plan.skipped.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground">
            {t(`${ns}.skipped`, { count: plan.skipped.length })}
          </p>
          <ul className="flex flex-col gap-0.5 text-muted-foreground">
            {plan.skipped.map(({ row, reason }) => (
              <li key={row.id} className="truncate" data-testid={`${testIdPrefix}-skip-${row.id}`}>
                {row.name}｜{t(skipKey[reason])}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
