# 2.0.5

_2026-09-08_

## English

### Fixes

- Mouse-wheel and trackpad scrolling in TUI apps such as Claude Code felt sticky after 2.0.4, even on fast local machines: the view lagged the finger and kept scrolling after you stopped. Scroll input is now released the moment the app finishes drawing a frame, and the backlog is kept tiny, so the view follows your finger and stops when you stop — without the dropped scroll events that 2.0.4 was fixing.

---

## 中文

### 修复

- 2.0.4 之后在 Claude Code 等 TUI 应用里用滚轮 / 触控板滚动显得粘滞，即使在本机也画面滞后手指、停手后还在滚。现在应用一画完一帧就立刻送入下一条滚动，积压保持极小，画面跟手、停手即停，同时保留 2.0.4 修掉的「滚动事件被整批丢弃」问题的修复。
