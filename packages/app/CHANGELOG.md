# 2.7.3

_2026-09-17_

## English

### Fixes

- One-line install no longer freezes at the first question. On a machine without Node.js installed, `curl … | bash` would print "Install directory (…)", then ignore everything you typed — Enter did nothing and the only way out was Ctrl-C. Setup now reads your answers correctly, so a fresh install goes through on the first try.
- When setup fails partway, the installer now says so and tells you the install is incomplete, instead of exiting silently and leaving you guessing how far it got.

---

## 中文

### 修复

- 一键安装不再卡在第一个问题上。在没装 Node.js 的机器上，`curl … | bash` 会停在「Install directory (…)」，输入什么都没反应、回车也不动，只能 Ctrl-C 退出。现在能正常读到你的回答，全新安装一次就能装完。
- 安装中途失败时会明确提示安装未完成，不再一声不吭地退出，让人猜不到装到了哪一步。
