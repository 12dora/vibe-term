# 直连地址的负向缓存与退避

## 背景

节点通过 hub 的 `node.list` 拿到对端广播的 LAN 地址，直连时把这些地址并行 race 一遍。生产上观察到某节点对同一批 13 个**永远不可达**的地址（docker 网桥 `172.17.x`、CGNAT `100.64/10`、IPv6 ULA）反复拨 39001 端口，没有任何记忆：每次升级尝试都全量重打一轮，日志刷屏且拖慢回落 relay。

本轮加了四层刹车：广播端少发、拨号端记住失败、LAN 候选设总预算、进程级限制并发。

## 广播端过滤（`enumeratePeerEndpoints`）

枚举网卡时保留网卡名（`Object.entries`），按名字跳过容器向网卡：`docker*`、`veth*`、`br-*`、`virbr*`、`lxdbr*`、`lxcbr*`、`cni*`、`flannel*`、`podman*`。**不跳过** `utun*` / `tun*`（Tailscale、WireGuard 要用）。

地址族规则：

- IPv6 ULA `fc00::/7` 与废弃的 site-local `fec0::/10` 默认不广播。
- CGNAT `100.64/10` 默认不广播，仅当本机自己有非 internal 的 `100.64/10` 地址时才广播（Tailscale 场景）。
- 普通网卡上的 RFC1918（`10.x`、`192.168.x`、`172.16–31.x`）照常广播。

真正挡住 docker 网桥的是**网卡名过滤**；地址段规则只是补漏。运营商把 `100.64` 配在 `en0` / `ppp0` 上时仍会广播，由接收侧退避消化。

**必须两侧都升级才彻底干净**：广播端升级后别人才看不到它的 docker 地址；接收端的退避用来保护面对尚未升级的旧广播者。

## 拨号端负向缓存（`PeerEndpointBackoff`）

key 是 `(nodeId, canonical host, port)`——canonical 会把 IPv4-mapped 形式归一，同一地址的不同写法算同一条。

- 退避 `1min → 2min → 4min …`，上限 **6h**（`ENDPOINT_BACKOFF_MIN_MS` / `ENDPOINT_BACKOFF_CAP_MS`）。
- **只有传输可达性失败计数**：`timeout`、`open-timeout`、`refused`、`unreachable`、`reset`。协议 / 信任类失败（peer-id 不符、签名失败、证书问题、`not-trusted`）**不缓存**——那是配置问题，重试地址没意义，但也不该把地址标成不可达。
- 成功即清除该地址；此前有过失败时打一条 `endpoint recovered`。
- 清空时机：对端广播的 endpoint 集合（canonical host+port 排序集）**实际发生变化**时清该节点；节点被吊销时清该节点；15s 扫描发现本机非 internal 地址指纹变化时 `resetAll()`。
- 空闲超过 24h 的条目被修剪。

日志（`[mesh][peer]` 前缀），在 fails = 1、3，以及之后每次翻倍（6、12、24…）打一条：

```
endpoint backoff node=<id> addr=<host:port> fails=<n> next=<iso>
endpoint recovered node=<id> addr=<host:port>
```

`dialWsSecure()` 先按退避过滤候选再 race，每个候选的成功 / 失败都回记。**全部候选都在退避中**时立即返回，让上层直接回落 relay，`directFailure.ws` 为：

```
all endpoints backing off (next eligible in Xs)
```

（`X` 为整数秒。这个字段对前端仍是不透明字符串，只是多了一种取值。）

## LAN 预算与并发

- LAN 候选（`classifyRemoteAddress === 'lan'`）总预算 `PEER_LAN_DIAL_TIMEOUT_MS = 4000`，**open + 握手合计**；超时 abort 并关闭 socket。
- 公网候选保持原样：open 3s（`PEER_CONNECT_TIMEOUT_MS`）+ 握手 10s。
- 显式传入更短的 `connectTimeoutMs` 仍然生效（取 `min(connect, total)`）。
- `DirectDialLimiter` 是进程单例，默认 4 个并发 endpoint dial，在**打开 socket 之前**获取名额、`finally` 释放；ranked stagger（250ms 错开）顺序不变。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TMEX_PEER_DIRECT_DIAL_CONCURRENCY` | `4` | 进程内同时进行的直连 endpoint 拨号数上限，整数 ≥ 1 |

## 强制探测

`PeerManager.forceProbe(nodeId, endpoints?)` 绕过负向缓存直接拨（仍要求 peer 可信，仍走正常签名握手）。**目前只是 gateway 内部方法，没有 HTTP 入口，也没有设置页按钮**；排查时只能改地址集合 / 重启来触发清空。

## 注意

- 无新增 REST 接口与 i18n key。
- 节点升级后 `node.status.endpoints` 不再包含 docker 网桥、默认 ULA 以及无 Tailscale 时的 CGNAT 地址；老节点仍会广播它们。
- 单测里进程级 limiter 在并行文件之间共享，需要隔离时给 `PeerManager` 注入独立 limiter。
