// 回放控制条静态渲染：testid、相对时钟、墙钟，以及输入标记条。
// 无 DOM 测试环境，用 react-dom/server 静态渲染；`t` 单跑/合跑不一致，不断言译文字符串。

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReplayControls, ReplayInputTicker } from './replay-controls';
import { formatReplayClock, formatReplayWallClock } from './replay-timeline';
import type { ReplayPlayer } from './use-replay-player';

const START = Date.UTC(2024, 0, 15, 6, 3, 27);

function player(patch: Partial<ReplayPlayer> = {}): ReplayPlayer {
  return {
    pane: null,
    paneId: '%1',
    startAt: START,
    currentMs: 1_000,
    durationMs: 5_000,
    playing: false,
    speed: 1,
    inputs: [],
    toggle: () => undefined,
    cycleSpeed: () => undefined,
    seek: () => undefined,
    selectPane: () => undefined,
    ...patch,
  };
}

describe('ReplayControls', () => {
  test('摆出播放、倍速、时间轴、相对时钟和墙钟', () => {
    const html = renderToStaticMarkup(
      <ReplayControls player={player()} panes={[{ paneId: '%1', bytes: 4 }]} disabled={false} />
    );
    expect(html).toContain('data-testid="share-replay-controls"');
    expect(html).toContain('data-testid="share-replay-toggle"');
    expect(html).toContain('data-testid="share-replay-speed"');
    expect(html).toContain('data-testid="share-replay-scrubber"');
    expect(html).toContain('data-testid="share-replay-timeline"');
    expect(html).toContain('data-testid="share-replay-clock"');
    expect(html).toContain('data-testid="share-replay-wall-clock"');
    expect(html).toContain(`${formatReplayClock(1_000)} / ${formatReplayClock(5_000)}`);
    expect(html).toContain(formatReplayWallClock(START + 1_000, 'en_US'));
  });

  test('禁用时 range 不可拖', () => {
    const html = renderToStaticMarkup(
      <ReplayControls player={player()} panes={[{ paneId: '%1', bytes: 4 }]} disabled />
    );
    expect(html).toContain('data-testid="share-replay-scrubber"');
    expect(html).toContain('disabled=""');
  });

  test('多 pane 才出选择器', () => {
    const one = renderToStaticMarkup(
      <ReplayControls player={player()} panes={[{ paneId: '%1', bytes: 4 }]} disabled={false} />
    );
    expect(one).not.toContain('data-testid="share-replay-pane"');
    const two = renderToStaticMarkup(
      <ReplayControls
        player={player()}
        panes={[
          { paneId: '%1', bytes: 4 },
          { paneId: '%2', bytes: 2 },
        ]}
        disabled={false}
      />
    );
    expect(two).toContain('data-testid="share-replay-pane"');
  });
});

describe('ReplayInputTicker', () => {
  test('空输入出空状态节点', () => {
    const html = renderToStaticMarkup(<ReplayInputTicker player={player()} />);
    expect(html).toContain('data-testid="share-replay-inputs"');
  });

  test('有标记时拼进等宽文本', () => {
    const html = renderToStaticMarkup(
      <ReplayInputTicker
        player={player({
          inputs: [
            { seq: 1, t: 0, text: 'a' },
            { seq: 2, t: 10, text: 'b' },
          ],
        })}
      />
    );
    expect(html).toContain('a b');
  });
});
