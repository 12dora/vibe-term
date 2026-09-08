# 2.0.6

_2026-09-08_

## English

### Fixes

- Mouse-wheel and trackpad scrolling in TUI apps (Claude Code and others) is back to the direct, immediate delivery of 2.0.3 — the extra pacing introduced in 2.0.4/2.0.5 made fast scrolling lag a beat and feel sticky. Scroll events are now written to the app as soon as tmux confirms the previous one, and the browser no longer holds follow-up scroll gestures for 16 ms.

---

## 中文

### 修复

- Claude Code 等 TUI 应用里的滚轮 / 触控板滚动恢复为 2.0.3 那样的即时直送——2.0.4/2.0.5 引入的节奏控制让快速滚动慢一拍、手感发粘。现在 tmux 一确认上一条滚动就立即送入下一条，浏览器也不再把后续滚动手势压 16 ms 再发。
