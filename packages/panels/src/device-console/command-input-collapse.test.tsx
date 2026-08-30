// 命令输入框的展开/收起：data-state 与过渡类名。bun test 无 DOM，
// 用 react-dom/server 静态渲染断言首帧形态；收起后延时卸载的时序由实现保证。

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  COMMAND_INPUT_COLLAPSE_MS,
  CommandInputCollapse,
  collapseDataState,
} from './command-input-collapse';

describe('collapseDataState', () => {
  test('展开态与收起态各对应一个 data-state', () => {
    expect(collapseDataState(true)).toBe('open');
    expect(collapseDataState(false)).toBe('closed');
  });
});

describe('CommandInputCollapse', () => {
  test('展开时渲染内容，带 open 态与高度/透明度过渡', () => {
    const html = renderToStaticMarkup(
      <CommandInputCollapse open>
        <span data-testid="command-input-body" />
      </CommandInputCollapse>
    );
    expect(html).toContain('data-testid="command-input-collapse"');
    expect(html).toContain('data-state="open"');
    expect(html).toContain('data-testid="command-input-body"');
    expect(html).toContain('grid-rows-[1fr]');
    expect(html).toContain('data-[state=closed]:grid-rows-[0fr]');
    expect(html).toContain('data-[state=closed]:opacity-0');
    expect(html).toContain('data-[state=closed]:translate-y-1');
    expect(html).toContain('duration-(--tmex-motion-layout)');
    expect(html).toContain('motion-reduce:transition-none');
  });

  test('未展开且从未展开过时不占位', () => {
    const html = renderToStaticMarkup(
      <CommandInputCollapse open={false}>
        <span data-testid="command-input-body" />
      </CommandInputCollapse>
    );
    expect(html).toBe('');
  });

  test('卸载延时与动效时长对齐，收起动画不会被提前打断', () => {
    expect(COMMAND_INPUT_COLLAPSE_MS).toBe(200);
  });
});
