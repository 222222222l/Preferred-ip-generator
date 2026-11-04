# Preferred IP Generator

[English](README.en.md)

基于 Cloudflare Workers 的 IP 来源聚合与订阅转换工具。项目实现来源读取、按来源筛选与去重、KV 缓存，以及 `bestip.txt` 和订阅格式输出；来源提供的延迟或带宽不是本项目对用户线路的实测结果。

## 当前边界

**订阅路由目前没有应用层鉴权。** `REFRESH_TOKEN` 只保护 `/refresh`，不保护 `/sub`、`/sub/clash` 或 `/sub/mihomo`。如果部署公开可达且配置了私人 `SUBSCRIPTION_UPSTREAM`，订阅内容会对能访问这些路由的人开放。如已公网部署，应先移除 `SUBSCRIPTION_UPSTREAM` 停用订阅代理，或在网关阻断未授权访问。连接私人订阅前，应先部署适用的访问控制；仅隐藏仓库或配置文件不能保护已运行的入口。

本项目是个人配置工具，未提供跨地区网络性能或服务可用性的系统评测。网页来源接口、签名方式及默认访问参数可能随上游变化；它们不构成来源方对持续使用或商业部署的授权。

## 行为与接口

- 带 `bandwidth` 的来源按 `MIN_BANDWIDTH_MB` 筛选，默认阈值为 20；该字段单位和测量方法以来源为准。
- 不含带宽字段的来源按其延迟排序，默认每来源最多 10 个结果。
- 默认包含 IPv4；IPv6 可配置。输出形如 `IP:端口#备注`。
- 订阅转换保留上游节点，替换本项目此前追加的 `AUTO-来源` 托管节点。

| 接口 | 用途 |
| --- | --- |
| `GET /bestip.txt` | 当前 IP 列表 |
| `GET /sub` | 读取配置的上游订阅并刷新托管节点 |
| `GET /sub/clash`、`/sub/mihomo` | 对应 YAML 输出 |
| `GET /sub?format=raw\|base64\|clash\|mihomo\|auto` | 选择输出格式 |
| `GET /status` | 缓存、来源、刷新错误和订阅入口状态 |
| `GET /refresh?token=...` | 受刷新令牌保护的手动刷新 |

默认来源为 [Uouin](https://api.uouin.com/index.php/index/Cloudflare)、[WeTest](https://www.wetest.vip/api/cf2dns/get_cloudflare_ip)、[HostMonit](https://api.hostmonit.com/get_optimization_ip) 和 [IPDB](https://github.com/ymyuuu/IPDB)。Uouin 使用网页加载流程中的签名方式；该接口并非本项目维护的正式 API。

## 配置与部署

复制 `.dev.vars.example` 为本地 `.dev.vars`，填写自己的配置。生产密钥使用 Worker secrets 或等效保密配置；不要提交订阅 URL、令牌或真实部署配置。

| 变量 | 含义 |
| --- | --- |
| `SOURCE_URL`、`SOURCE_URLS` | 单个或逗号分隔的来源 |
| `MAX_RESULTS`、`MIN_BANDWIDTH_MB` | 每来源数量上限、带宽阈值 |
| `INCLUDE_IPV6`、`LINE_ALLOWLIST` | IPv6、线路筛选 |
| `PORT_CANDIDATES`、`FALLBACK_PORT` | 候选端口、缺省端口 |
| `REFRESH_INTERVAL_MINUTES`、`SOURCE_FRESHNESS_HOURS` | 刷新间隔、来源最大陈旧时间 |
| `REMARK_PREFIX`、`PORT_PROBE_HOST` | 备注前缀、可选探测域名 |
| `CF2DNS_KEY` | 来源访问参数 |
| `SUBSCRIPTION_UPSTREAM` | 私人上游订阅；先解决上述访问控制 |
| `REFRESH_TOKEN` | 仅用于手动刷新鉴权 |

```bash
npm install
npx wrangler login
npx wrangler kv namespace create BEST_IP_KV
npx wrangler kv namespace create BEST_IP_KV --preview
```

将返回的 KV 标识填入本地 `wrangler.toml`，核对访问控制与来源规则后运行 `npx wrangler deploy`。实现见 [src/index.js](src/index.js)。

## 证据与许可

筛选顺序、缓存和格式转换由代码定义；“优选”不保证对任意运营商、地区或时间更快。评估时应保留来源时间、地区、重复测量和失败率，并比较相同线路下的基线。本仓库当前未提供顶层 `LICENSE`；第三方来源的访问与再分发条件分别适用。本项目与 Cloudflare 及来源服务没有官方隶属关系。
