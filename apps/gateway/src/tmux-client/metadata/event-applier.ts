import { collectLayoutLeaves, layoutLeafPaneId, parseWindowLayout, wsBorsh } from '@tmex/shared';

import type { TmuxSourceMetadataEvent } from '../events';
import { PARKING_WINDOW_NAME } from '../external/constants';
import {
  type MetadataValue,
  type PaneFieldHints,
  type ProjectedRecord,
  boolValue,
  keyId,
  stringValue,
  u16Value,
  valueEqual,
} from './types';

export interface MetadataEventApplyHost {
  records: Map<string, ProjectedRecord>;
  rememberUnknownPane(paneId: string, fields: PaneFieldHints): void;
  setRecordField(
    record: ProjectedRecord,
    field: number,
    value: MetadataValue | null,
    revision: bigint
  ): void;
  removeRecord(record: ProjectedRecord, revision: bigint): void;
}

export interface ApplyContext {
  nextRevision: bigint;
  actions: Array<() => void>;
  setField: (kind: number, nativeId: string, field: number, value: MetadataValue) => boolean;
  queueActiveChild: (childKind: number, parentNativeId: string, activeNativeId: string) => void;
  rememberUnknownPane: (paneId: string, fields: PaneFieldHints) => void;
  records: Map<string, ProjectedRecord>;
  removeRecord: (record: ProjectedRecord, revision: bigint) => void;
}

type EventHandlerMap = {
  [K in TmuxSourceMetadataEvent['type']]: (
    event: Extract<TmuxSourceMetadataEvent, { type: K }>,
    ctx: ApplyContext
  ) => void;
};

function recordStringField(record: ProjectedRecord | undefined, field: number): string {
  const value = record?.fields.get(field)?.value;
  return value && 'String' in value && value.String ? value.String : 'unknown';
}

function windowPaneCommand(records: Map<string, ProjectedRecord>, windowId: string): string {
  let fallback: string | null = null;
  for (const record of records.values()) {
    if (
      record.key.entityKind !== wsBorsh.SOURCE_ENTITY_PANE ||
      record.parent?.nativeId !== windowId
    ) {
      continue;
    }
    const command = recordStringField(record, wsBorsh.SOURCE_FIELD_CURRENT_COMMAND);
    const active = record.fields.get(wsBorsh.SOURCE_FIELD_ACTIVE)?.value;
    if (active && 'Bool' in active && active.Bool) return command;
    fallback ??= command;
  }
  return fallback ?? 'unknown';
}

/**
 * tmux 自己销毁窗口时没有任何调用方可查，只能把观察到的关闭连同最后已知信息记下来。
 * `exitStatus` 恒为 null：`#{pane_dead_status}` 只在 `remain-on-exit on` 时才有值，
 * 而 tmex 从不设它——窗口在 `%window-close` 到达时已经不存在，无处可查。
 * 保留形参是为了将来真开了 remain-on-exit 时能把退出码填进同一行。
 */
export function formatWindowCloseObserved(
  windowId: string,
  record: ProjectedRecord | undefined,
  records: Map<string, ProjectedRecord>,
  exitStatus: string | null = null
): string {
  const name = recordStringField(record, wsBorsh.SOURCE_FIELD_NAME);
  const command = windowPaneCommand(records, windowId);
  return `[tmux] window-close observed id=${windowId} name=${name} pane_current_command=${command} exit_status=${exitStatus ?? 'unavailable'} tracked=${record ? 'yes' : 'no'}`;
}

const EVENT_HANDLERS: EventHandlerMap = {
  'pane-title'(event, ctx) {
    if (
      !ctx.setField(
        wsBorsh.SOURCE_ENTITY_PANE,
        event.paneId,
        wsBorsh.SOURCE_FIELD_TITLE,
        stringValue(event.title)
      )
    ) {
      ctx.rememberUnknownPane(event.paneId, { title: event.title });
    }
  },
  'pane-current-path'(event, ctx) {
    if (
      !ctx.setField(
        wsBorsh.SOURCE_ENTITY_PANE,
        event.paneId,
        wsBorsh.SOURCE_FIELD_CURRENT_PATH,
        stringValue(event.currentPath)
      )
    ) {
      ctx.rememberUnknownPane(event.paneId, { currentPath: event.currentPath });
    }
  },
  'pane-current-command'(event, ctx) {
    if (
      !ctx.setField(
        wsBorsh.SOURCE_ENTITY_PANE,
        event.paneId,
        wsBorsh.SOURCE_FIELD_CURRENT_COMMAND,
        stringValue(event.currentCommand)
      )
    ) {
      ctx.rememberUnknownPane(event.paneId, { currentCommand: event.currentCommand });
    }
  },
  'session-renamed'(event, ctx) {
    ctx.setField(
      wsBorsh.SOURCE_ENTITY_SESSION,
      event.sessionId,
      wsBorsh.SOURCE_FIELD_NAME,
      stringValue(event.name)
    );
  },
  'window-renamed'(event, ctx) {
    // 真实窗口不会被改成聚焦护盾的名字：出现即说明护盾窗口漏进来了，不投影它
    if (event.name === PARKING_WINDOW_NAME) return;
    ctx.setField(
      wsBorsh.SOURCE_ENTITY_WINDOW,
      event.windowId,
      wsBorsh.SOURCE_FIELD_NAME,
      stringValue(event.name)
    );
  },
  'session-window-changed'(event, ctx) {
    ctx.queueActiveChild(wsBorsh.SOURCE_ENTITY_WINDOW, event.sessionId, event.windowId);
  },
  'window-pane-changed'(event, ctx) {
    ctx.queueActiveChild(wsBorsh.SOURCE_ENTITY_PANE, event.windowId, event.paneId);
  },
  'layout-change'(event, ctx) {
    ctx.setField(
      wsBorsh.SOURCE_ENTITY_WINDOW,
      event.windowId,
      wsBorsh.SOURCE_FIELD_LAYOUT,
      stringValue(event.layout)
    );
    const parsed = parseWindowLayout(event.layout);
    if (!parsed) return;
    for (const leaf of collectLayoutLeaves(parsed.root)) {
      const paneId = layoutLeafPaneId(leaf);
      ctx.setField(
        wsBorsh.SOURCE_ENTITY_PANE,
        paneId,
        wsBorsh.SOURCE_FIELD_WIDTH,
        u16Value(leaf.width)
      );
      ctx.setField(
        wsBorsh.SOURCE_ENTITY_PANE,
        paneId,
        wsBorsh.SOURCE_FIELD_HEIGHT,
        u16Value(leaf.height)
      );
      ctx.setField(wsBorsh.SOURCE_ENTITY_PANE, paneId, wsBorsh.SOURCE_FIELD_LEFT, u16Value(leaf.x));
      ctx.setField(wsBorsh.SOURCE_ENTITY_PANE, paneId, wsBorsh.SOURCE_FIELD_TOP, u16Value(leaf.y));
    }
  },
  'window-close'(event, ctx) {
    const record = ctx.records.get(
      keyId({ entityKind: wsBorsh.SOURCE_ENTITY_WINDOW, nativeId: event.windowId })
    );
    console.info(formatWindowCloseObserved(event.windowId, record, ctx.records));
    if (record) ctx.actions.push(() => ctx.removeRecord(record, ctx.nextRevision));
  },
};

export class MetadataEventApplier {
  constructor(private readonly host: MetadataEventApplyHost) {}

  cacheUnknown(event: TmuxSourceMetadataEvent): void {
    if (event.type === 'pane-title') {
      this.host.rememberUnknownPane(event.paneId, { title: event.title });
    }
    if (event.type === 'pane-current-path') {
      this.host.rememberUnknownPane(event.paneId, { currentPath: event.currentPath });
    }
    if (event.type === 'pane-current-command') {
      this.host.rememberUnknownPane(event.paneId, { currentCommand: event.currentCommand });
    }
  }

  collect(event: TmuxSourceMetadataEvent, nextRevision: bigint): Array<() => void> {
    const actions: Array<() => void> = [];
    const ctx: ApplyContext = {
      nextRevision,
      actions,
      records: this.host.records,
      rememberUnknownPane: (paneId, fields) => this.host.rememberUnknownPane(paneId, fields),
      removeRecord: (record, revision) => this.host.removeRecord(record, revision),
      setField: (kind, nativeId, field, value) =>
        this.setField(kind, nativeId, field, value, nextRevision, actions),
      queueActiveChild: (childKind, parentNativeId, activeNativeId) =>
        this.queueActiveChild(childKind, parentNativeId, activeNativeId, nextRevision, actions),
    };
    const handler = EVENT_HANDLERS[event.type] as (
      event: TmuxSourceMetadataEvent,
      ctx: ApplyContext
    ) => void;
    handler(event, ctx);
    return actions;
  }

  private setField(
    kind: number,
    nativeId: string,
    field: number,
    value: MetadataValue,
    nextRevision: bigint,
    actions: Array<() => void>
  ): boolean {
    const record = this.host.records.get(keyId({ entityKind: kind, nativeId }));
    if (!record) return false;
    if (valueEqual(record.fields.get(field)?.value, value)) return true;
    actions.push(() => this.host.setRecordField(record, field, value, nextRevision));
    return true;
  }

  private queueActiveChild(
    childKind: number,
    parentNativeId: string,
    activeNativeId: string,
    revision: bigint,
    actions: Array<() => void>
  ): void {
    for (const record of this.host.records.values()) {
      if (
        record.key.entityKind !== childKind ||
        record.parent?.nativeId !== parentNativeId ||
        record.parent.entityKind !== childKind - 1
      ) {
        continue;
      }
      const next = boolValue(record.key.nativeId === activeNativeId);
      if (valueEqual(record.fields.get(wsBorsh.SOURCE_FIELD_ACTIVE)?.value, next)) continue;
      actions.push(() =>
        this.host.setRecordField(record, wsBorsh.SOURCE_FIELD_ACTIVE, next, revision)
      );
    }
  }
}
