import type { UiThreadBlock } from '@tmex/stores';
import type { CSSProperties, ReactElement } from 'react';

import { AssistantMessage } from './messages/assistant-message';
import { ReasoningBlock } from './messages/reasoning-block';
import { ToolCallCard } from './messages/tool-call-card';
import { UserMessage } from './messages/user-message';

/** 超过这么多块才给行加 content-visibility：短会话全在视口里，跳渲判定纯属多余 */
export const CHAT_ROW_SKIP_RENDER_THRESHOLD = 40;
/** 视口外的块只留占位高度；`auto` 会记住真实渲染过的高度，滚回去不会跳 */
const SKIPPED_ROW_STYLE: CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 64px',
};

export type Decide = (confirmationId: string, approved: boolean) => void;

/**
 * 每个块渲染成一个 React.memo 行：key 取块 id，props 全是稳定引用或原始值，
 * 于是流式期间只有尾部的块换了对象、只有尾行重渲染。
 */
export function threadRows(
  blocks: UiThreadBlock[],
  confirmationByToolCallId: Map<string, string>,
  onDecide: Decide
): ReactElement[] {
  const rows: ReactElement[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'user':
        rows.push(<UserMessage key={block.key} text={block.text} />);
        break;
      case 'assistant-text':
        rows.push(
          <AssistantMessage key={block.key} text={block.text} streaming={block.streaming} />
        );
        break;
      case 'reasoning':
        rows.push(<ReasoningBlock key={block.key} text={block.text} streaming={block.streaming} />);
        break;
      case 'tool-call':
        rows.push(
          <ToolCallCard
            key={block.key}
            call={block.call}
            confirmationId={confirmationByToolCallId.get(block.call.toolCallId)}
            onDecide={onDecide}
          />
        );
        break;
      default:
        break;
    }
  }
  return rows;
}

/** 行外包一层 flex 列：块自己的 self-start / self-end 仍然生效，跳渲样式挂在这一层。 */
export function ThreadRows({ rows }: { rows: ReactElement[] }): ReactElement {
  const style = rows.length > CHAT_ROW_SKIP_RENDER_THRESHOLD ? SKIPPED_ROW_STYLE : undefined;
  return (
    <>
      {rows.map((row) => (
        <div key={row.key} className="flex flex-col" style={style}>
          {row}
        </div>
      ))}
    </>
  );
}
