// 侧边栏分节的出入场：分节按可见性/在线状态整节 return null，切 node 时会直接「啪」地消失。
// 这里给一层最轻的 presence 外壳——入场淡入、退场淡出后再卸载，reduced motion 下直接落到终态
// （与 connection-indicator 同一套做法：没有过渡就不能等 transitionend）。
//
// 只用 transition 不用 tmex-fade：动画的 fill-mode 是 both，播完会把 opacity 永久钉在 1，
// 分节根上拖拽用的 opacity-60 就再也压不住了；纯 class 才能让 tailwind-merge 正常收敛。

import { motionDurations, useReducedMotion } from '@tmex/ui/motion';
import { useEffect, useRef, useState } from 'react';

type Phase = 'hidden' | 'entering' | 'visible' | 'exiting';

const TRANSITION =
  'transition-opacity duration-(--tmex-motion-standard) motion-reduce:transition-none';

const CLASS_BY_PHASE: Record<Phase, string> = {
  hidden: `${TRANSITION} ease-out opacity-0`,
  entering: `${TRANSITION} ease-out opacity-0`,
  visible: `${TRANSITION} ease-out opacity-100`,
  exiting: `${TRANSITION} ease-in opacity-0 pointer-events-none`,
};

export interface SectionPresence<T> {
  /** 是否还要渲染：退场过渡期间仍为 true */
  rendered: boolean;
  /** 退场期间锁住最后一份内容，避免一边淡出一边掉内容 */
  value: T;
  /** 挂在分节根元素上的入场 / 退场类名；调用方的拖拽半透明要排在它后面 */
  className: string;
}

export function useSectionPresence<T>(present: boolean, value: T): SectionPresence<T> {
  const reducedMotion = useReducedMotion();
  // 首次渲染就在场的分节直接落 visible：整棵侧边栏刚挂上时不该集体淡入一遍
  const [phase, setPhase] = useState<Phase>(present ? 'visible' : 'hidden');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const latched = useRef(value);
  if (present) latched.current = value;

  useEffect(() => {
    if (reducedMotion) {
      setPhase(present ? 'visible' : 'hidden');
      return;
    }
    if (present) {
      if (phaseRef.current === 'visible') return;
      setPhase('entering');
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setPhase('visible'));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    if (phaseRef.current === 'hidden') return;
    setPhase('exiting');
    const timer = setTimeout(() => setPhase('hidden'), motionDurations.standard);
    return () => clearTimeout(timer);
  }, [present, reducedMotion]);

  return {
    rendered: present || phase !== 'hidden',
    value: present ? value : latched.current,
    className: CLASS_BY_PHASE[phase],
  };
}
