// 登录历史的表格（sm 以上）与记录卡（sm 以下）。两套版式只挂一套 DOM，testid 逐个对齐。

import {
  RecordCard,
  RecordCardEmpty,
  RecordCardList,
  RecordCardMeta,
  RecordCardTitle,
} from '@/components/record-card';
import { useNarrowLayout } from '@/components/use-narrow-layout';
import { Badge } from '@vibeterm/ui/badge';
import { useTranslation } from 'react-i18next';
import { WideTableScroll } from '../../components/wide-table';
import { EmptyRow, Td, Th } from '../../share/table-parts';
import type { LoginHistoryOutcome, LoginHistoryRow } from './login-history-data';
import {
  absoluteTimeText,
  accountText,
  clientText,
  entryNodeText,
  methodText,
  reasonText,
  relativeTimeText,
} from './login-history-format';
import { userAgentSummary } from './user-agent';

export interface LoginHistoryTableProps {
  rows: LoginHistoryRow[];
  outcome: LoginHistoryOutcome;
  now: number;
  /** mesh id → 节点名：后台登录的入口列用。 */
  nodeNames: ReadonlyMap<string, string>;
  emptyText: string;
}

export function LoginHistoryTable(props: LoginHistoryTableProps) {
  const narrow = useNarrowLayout();
  return narrow ? <LoginHistoryCards {...props} /> : <LoginHistoryWideTable {...props} />;
}

function EntryHint({
  row,
  nodeNames,
}: { row: LoginHistoryRow; nodeNames: ReadonlyMap<string, string> }) {
  const { t } = useTranslation();
  if (row.kind !== 'background') return null;
  const entry = entryNodeText(row.viaNodeId, nodeNames);
  return (
    <span className="text-muted-foreground" data-testid={`login-history-entry-${row.rowKey}`}>
      {entry
        ? t('settings.loginHistory.viaEntry', { name: entry })
        : t('settings.loginHistory.background')}
    </span>
  );
}

function DeviceText({ userAgent }: { userAgent: string | null | undefined }) {
  return <span title={userAgent ?? undefined}>{userAgentSummary(userAgent) ?? '—'}</span>;
}

export function LoginHistoryWideTable({
  rows,
  outcome,
  now,
  nodeNames,
  emptyText,
}: LoginHistoryTableProps) {
  const { t } = useTranslation();
  const failed = outcome === 'failed';
  const columns = failed ? 8 : 6;
  return (
    <WideTableScroll>
      <table
        className={`w-full text-xs ${failed ? 'min-w-[60rem]' : 'min-w-[48rem]'}`}
        data-testid="login-history-table"
      >
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <Th>{t('settings.loginHistory.columns.time')}</Th>
            <Th>{t('settings.loginHistory.columns.node')}</Th>
            {failed && <Th>{t('settings.loginHistory.columns.account')}</Th>}
            <Th>{t('settings.loginHistory.columns.method')}</Th>
            {failed && <Th>{t('settings.loginHistory.columns.reason')}</Th>}
            <Th>{t('settings.loginHistory.columns.client')}</Th>
            <Th>{t('settings.loginHistory.columns.ip')}</Th>
            <Th>{t('settings.loginHistory.columns.device')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.rowKey}
              className="border-b border-border/60 last:border-0 hover:bg-muted/40"
              data-testid={`login-history-row-${row.rowKey}`}
            >
              <Td title={absoluteTimeText(row.at)}>{relativeTimeText(t, row.at, now)}</Td>
              <Td className="max-w-56">
                <span className="flex flex-col">
                  <span className="truncate">{row.node.name}</span>
                  <EntryHint row={row} nodeNames={nodeNames} />
                </span>
              </Td>
              {failed && (
                <Td className="max-w-40 truncate" title={accountText(row)}>
                  {accountText(row)}
                </Td>
              )}
              <Td>{methodText(t, row)}</Td>
              {failed && (
                <Td className="text-destructive" testId={`login-history-reason-${row.rowKey}`}>
                  {reasonText(t, row.code)}
                </Td>
              )}
              <Td>{clientText(t, row.client)}</Td>
              <Td className="font-mono">{row.ip || '—'}</Td>
              <Td className="max-w-48 truncate">
                <DeviceText userAgent={row.userAgent} />
              </Td>
            </tr>
          ))}
          {rows.length === 0 && (
            <EmptyRow colSpan={columns} testId="login-history-empty">
              {emptyText}
            </EmptyRow>
          )}
        </tbody>
      </table>
    </WideTableScroll>
  );
}

export function LoginHistoryCards({
  rows,
  outcome,
  now,
  nodeNames,
  emptyText,
}: LoginHistoryTableProps) {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return <RecordCardEmpty testId="login-history-empty">{emptyText}</RecordCardEmpty>;
  }
  return (
    <RecordCardList testId="login-history-table">
      {rows.map((row) => (
        <RecordCard key={row.rowKey} testId={`login-history-row-${row.rowKey}`}>
          <RecordCardTitle>
            <span className="font-medium" title={absoluteTimeText(row.at)}>
              {relativeTimeText(t, row.at, now)}
            </span>
            <span className="truncate">{row.node.name}</span>
            {row.kind === 'background' && (
              <Badge variant="outline">{t('settings.loginHistory.background')}</Badge>
            )}
          </RecordCardTitle>
          {outcome === 'failed' && (
            <span className="text-destructive" data-testid={`login-history-reason-${row.rowKey}`}>
              {reasonText(t, row.code)}
            </span>
          )}
          <RecordCardMeta>
            {outcome === 'failed' && <span>{accountText(row)}</span>}
            <span>{methodText(t, row)}</span>
            <span>{clientText(t, row.client)}</span>
          </RecordCardMeta>
          <RecordCardMeta>
            <span className="font-mono">{row.ip || '—'}</span>
            <DeviceText userAgent={row.userAgent} />
            {row.kind === 'background' && <EntryHint row={row} nodeNames={nodeNames} />}
          </RecordCardMeta>
        </RecordCard>
      ))}
    </RecordCardList>
  );
}
