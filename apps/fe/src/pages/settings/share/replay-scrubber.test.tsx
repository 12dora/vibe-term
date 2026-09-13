// 时间轴子件：无 hook 的标签 / 起止 / range 可直接调用；整条 scrubber 走静态渲染。
// `t` 单跑/合跑不一致，不断言译文字符串。

import { describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ReplayPreviewLabel,
  ReplayRangeEnds,
  ReplayRangeInput,
  ReplayScrubber,
  ReplayTickRail,
} from './replay-scrubber';
import { clampReplayPreviewX, formatReplayDate, formatReplayWallClock } from './replay-timeline';

const START = Date.UTC(2024, 0, 15, 6, 3, 27);

describe('ReplayRangeInput', () => {
  test('点选进度把毫秒回传，不带 hook', () => {
    const picked: number[] = [];
    const input = ReplayRangeInput({
      currentMs: 1_000,
      durationMs: 5_000,
      disabled: false,
      wallClock: '14:03:28',
      seekLabel: 'seek',
      onChange: (ms) => picked.push(ms),
    });
    const props = input.props as {
      onChange: (event: { target: { value: string } }) => void;
      'data-testid'?: string;
      max: number;
      value: number;
    };
    expect(props['data-testid']).toBe('share-replay-scrubber');
    expect(props.max).toBe(5_000);
    expect(props.value).toBe(1_000);
    props.onChange({ target: { value: '2400' } });
    expect(picked).toEqual([2_400]);
  });

  test('禁用态带 disabled', () => {
    const html = renderToStaticMarkup(
      <ReplayRangeInput
        currentMs={0}
        durationMs={1}
        disabled
        wallClock=""
        seekLabel="seek"
        onChange={() => undefined}
      />
    );
    expect(html).toContain('disabled=""');
  });
});

describe('ReplayPreviewLabel', () => {
  test('墙上时间按 epoch 格式化，位置夹在轨道内', () => {
    const html = renderToStaticMarkup(
      <ReplayPreviewLabel
        epochMs={START + 1_000}
        ratio={0}
        trackWidth={200}
        language="en_US"
        ariaLabel="preview"
      />
    );
    expect(html).toContain('data-testid="share-replay-preview"');
    expect(html).toContain(formatReplayWallClock(START + 1_000, 'en_US'));
    expect(html).toContain(`left:${clampReplayPreviewX(0, 200, 72)}px`);
  });
});

describe('ReplayRangeEnds', () => {
  test('两端是墙钟；同日不标日期', () => {
    const html = renderToStaticMarkup(
      <ReplayRangeEnds
        startAt={START}
        durationMs={5_000}
        language="en_US"
        startLabel="start"
        endLabel="end"
      />
    );
    expect(html).toContain('data-testid="share-replay-start-label"');
    expect(html).toContain('data-testid="share-replay-end-label"');
    expect(html).toContain(formatReplayWallClock(START, 'en_US'));
    expect(html).toContain(formatReplayWallClock(START + 5_000, 'en_US'));
    expect(html).not.toContain('data-testid="share-replay-start-date"');
  });

  test('跨本地日历日时在起点下补一次日期', () => {
    const evening = new Date(2024, 0, 15, 23, 0, 0).getTime();
    const html = renderToStaticMarkup(
      <ReplayRangeEnds
        startAt={evening}
        durationMs={2 * 60 * 60_000}
        language="en_US"
        startLabel="start"
        endLabel="end"
      />
    );
    expect(html).toContain('data-testid="share-replay-start-date"');
    expect(html).toContain(formatReplayDate(evening, 'en_US'));
  });
});

describe('ReplayTickRail', () => {
  test('按时长画出主刻度', () => {
    const html = renderToStaticMarkup(
      <ReplayTickRail startAt={START} durationMs={5_000} widthPx={480} language="en_US" />
    );
    expect(html).toContain('data-testid="share-replay-ticks"');
    expect(html.split('data-testid="share-replay-tick"').length - 1).toBe(6);
    expect(html).toContain(formatReplayWallClock(START + 1_000, 'en_US'));
  });
});

describe('ReplayScrubber', () => {
  test('包着原生 range，初始不显示预览气泡', () => {
    const html = renderToStaticMarkup(
      <ReplayScrubber
        startAt={START}
        currentMs={1_000}
        durationMs={5_000}
        disabled={false}
        language="en_US"
        onSeek={() => undefined}
      />
    );
    expect(html).toContain('data-testid="share-replay-timeline"');
    expect(html).toContain('data-testid="share-replay-scrubber"');
    expect(html).toContain('data-testid="share-replay-start-label"');
    expect(html).toContain('data-testid="share-replay-end-label"');
    expect(html).not.toContain('data-testid="share-replay-preview"');
    expect(html).toContain('type="range"');
  });
});

describe('ReplayRangeInput tree', () => {
  test('返回的就是 input 元素', () => {
    const input = ReplayRangeInput({
      currentMs: 0,
      durationMs: 1,
      disabled: false,
      wallClock: '',
      seekLabel: 's',
      onChange: () => undefined,
    });
    expect((input as ReactElement).type).toBe('input');
  });
});
