import { describe, expect, it } from 'bun:test';

import { motionDurations, revealClassName, revealDelayStyle, staggerItemStyle } from './motion';

describe('motion tokens', () => {
  it('时长档位与 motion.css 中的 token 保持一致', () => {
    expect(motionDurations).toEqual({ fast: 100, standard: 150, layout: 200, slow: 300 });
  });

  it('类名与 motion.css 中定义的一致', () => {
    expect(revealClassName).toBe('vibeterm-reveal');
  });
});

describe('staggerItemStyle', () => {
  it('把序号写进 --vibeterm-stagger-index', () => {
    expect(staggerItemStyle(3)).toEqual({ '--vibeterm-stagger-index': 3 } as never);
  });

  it('负序号收敛到 0', () => {
    expect(staggerItemStyle(-2)).toEqual({ '--vibeterm-stagger-index': 0 } as never);
  });
});

describe('revealDelayStyle', () => {
  it('未传延迟时不产生内联样式', () => {
    expect(revealDelayStyle(undefined)).toBeUndefined();
  });

  it('延迟以 ms 单位写入 animationDelay', () => {
    expect(revealDelayStyle(70)).toEqual({ animationDelay: '70ms' });
  });

  it('负延迟收敛到 0', () => {
    expect(revealDelayStyle(-10)).toEqual({ animationDelay: '0ms' });
  });
});
