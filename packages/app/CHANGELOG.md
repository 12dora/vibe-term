# 2.2.2

_2026-09-12_

## English

### Fixes

- **TURN finally produces relay candidates.** The ICE engine (libjuice) does not support TURN while UDP multiplexing is on, and the node always turned multiplexing on — so any `VIBETERM_TURN_*` configuration was silently ignored and pairs that cannot hole-punch stayed on the relay. When a TURN server is configured the node now disables UDP multiplexing; each direct link then uses its own UDP port, which `VIBETERM_RTC_PORT_RANGE` can confine.

### Upgrade notes

- Only nodes need this release; the hub / relay configuration is unchanged. Nodes running an older version keep working without TURN.

---

## 中文

### 修复

- **TURN 终于能产生 relay 候选。** ICE 引擎（libjuice）在 UDP 复用开启时不支持 TURN，而节点一直强制开启复用，于是所有 `VIBETERM_TURN_*` 配置都被静默忽略，打不通洞的对子只能留在中继。现在配置了 TURN 的节点会关闭 UDP 复用，每条直连各占一个 UDP 端口，可用 `VIBETERM_RTC_PORT_RANGE` 圈定范围。

### 升级说明

- 只有节点需要升级；hub / 中继配置不变。老版本节点照常工作，只是没有 TURN。
