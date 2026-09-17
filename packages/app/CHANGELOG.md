# 2.7.2

_2026-09-18_

## English

### Fixes

- A node could keep showing "Connection failed" on every visit while the terminal itself worked perfectly. This happens when the tmux socket becomes unreachable — for example when `/tmp` is remounted, or the socket directory is cleaned up, after tmux has already started. The session keeps running, but every short tmux command fails. VibeTerm now recognises this, asks the tmux server to recreate its socket (creating the socket directory first, as tmux requires), and retries the command. If it can't be recovered, the failure is reported as before.
- A device error that has healed now disappears on its own. Previously the error was only cleared when the connection was re-established — and in the case above the connection never drops, so the message stayed forever and popped up on every visit. Any short tmux command that succeeds again now clears it and takes the warning down.
- One failed tmux command produced up to three identical pop-ups. It is now reported once.
- On SSH devices, a failed tmux command is now reported the same way as on local ones, so the error still reaches the interface instead of being silently swallowed.

---

## 中文

### 修复

- 某台节点每次进去都提示「连接失败」，但终端本身一切正常。这类故障出在 tmux 套接字变得不可达——比如 tmux 起来之后 `/tmp` 被重新挂载，或套接字目录被清理：会话照常跑，但新起的一次性 tmux 命令全部失败。现在 VibeTerm 能识别这种情况，按 tmux 的规定让服务器重建套接字（先按要求补出套接字目录），并重试那条命令；实在恢复不了，仍按原来的方式报错。
- 已经恢复的设备错误会自己消失。此前错误只在重新连上时才清，而上述故障里连接从不断开，于是提示一直挂着、每次进入都弹。现在任何一次一次性 tmux 命令重新跑通，就会清掉它并撤下提示。
- 同一次 tmux 命令失败此前最多会弹三条相同提示，现在只报一次。
- SSH 设备上的 tmux 命令失败，现在与本机一样上报，错误不会再被静默吞掉。
