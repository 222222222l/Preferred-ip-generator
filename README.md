# Preferred IP Generator

基于 Cloudflare Workers 的自用优选 IP 聚合工具。它会从多个来源读取 Cloudflare 优选 IP，按来源分别筛选、排序、去重，并生成稳定的 `bestip.txt` 与订阅代理入口。

## 功能

- 聚合多个 Cloudflare 优选 IP 来源
- 默认优先接入 Uouin 网页端数据接口，并保留 WeTest、HostMonit、GitHubRaw 作为补充来源
- 对带 `bandwidth` 字段的来源，默认筛选带宽大于 `20MB` 的 IPv4 节点
- 对不带 `bandwidth` 字段的来源，按延迟从低到高取前 `10` 个节点
- 输出 `IP:端口#备注` 格式的 `/bestip.txt`
- 代理上游订阅 `/sub`，刷新优选 IP 后替换本项目上一次追加的托管节点
- 托管节点名称会带来源前缀，例如 `AUTO-Uouin`、`AUTO-WeTest`、`AUTO-HostMonit`

## 路由

- `GET /bestip.txt`
  输出当前优选 IP 列表。

- `GET /sub`
  读取 `SUBSCRIPTION_UPSTREAM`，先刷新优选 IP，再用当前结果替换历史托管节点。

- `GET /sub/clash`
  输出 Clash 兼容 YAML。

- `GET /sub/mihomo`
  输出 Mihomo 兼容 YAML。

- `GET /sub?format=raw|base64|clash|mihomo|auto`
  指定订阅输出格式。

- `GET /status`
  查看缓存、来源、刷新错误和订阅入口状态。

- `GET /refresh?token=...`
  手动触发刷新。

## 默认来源

```text
https://api.uouin.com/index.php/index/Cloudflare
https://www.wetest.vip/api/cf2dns/get_cloudflare_ip
https://api.hostmonit.com/get_optimization_ip
https://raw.githubusercontent.com/ymyuuu/IPDB/main/bestcf.txt
```

Uouin 来源使用网页端公开加载数据时的签名方式接入，适合个人自用和学习研究。它不是本项目维护的官方 API，稳定性、可用性和访问规则以对方站点实际策略为准。

## 配置

部署前请复制并填写自己的配置，不要提交真实密钥、KV ID 或订阅地址。

| 变量 | 说明 |
| --- | --- |
| `SOURCE_URL` | 主来源 URL |
| `SOURCE_URLS` | 多来源列表，逗号分隔 |
| `MAX_RESULTS` | 每个来源最多选取多少个节点，默认 `10` |
| `MIN_BANDWIDTH_MB` | 带宽来源的最低带宽阈值，默认 `20` |
| `INCLUDE_IPV6` | 是否包含 IPv6，默认 `false` |
| `LINE_ALLOWLIST` | 可选线路白名单，逗号分隔 |
| `PORT_CANDIDATES` | 端口候选列表 |
| `FALLBACK_PORT` | 默认端口，通常为 `443` |
| `REFRESH_INTERVAL_MINUTES` | 缓存刷新周期 |
| `SOURCE_FRESHNESS_HOURS` | 来源时间戳最大可接受陈旧时间 |
| `REMARK_PREFIX` | `bestip.txt` 备注前缀 |
| `PORT_PROBE_HOST` | 可选端口探测域名 |
| `CF2DNS_KEY` | cf2dns 生态来源访问 key |
| `SUBSCRIPTION_UPSTREAM` | 上游原始订阅地址 |
| `REFRESH_TOKEN` | 手动刷新 token |

本地调试可复制：

```bash
cp .dev.vars.example .dev.vars
```

## 部署

```bash
npm install
npx wrangler login
npx wrangler kv namespace create BEST_IP_KV
npx wrangler kv namespace create BEST_IP_KV --preview
npx wrangler deploy
```

把创建出的 KV `id` 和 `preview_id` 写入 `wrangler.toml` 后再部署。

## 安全提示

- 不要将真实的 `SUBSCRIPTION_UPSTREAM`、`REFRESH_TOKEN`、KV ID、订阅 token 提交到公开仓库。
- 推荐把真实配置放在 Cloudflare Dashboard 的 Worker Variables / Secrets 或本地 `.dev.vars` 中。
- 仓库中的 `wrangler.toml` 应保持占位值。

## 免责声明

本项目仅用于个人学习、网络连通性测试和自用配置管理。使用者应自行确认数据来源的授权范围、服务条款和访问频率限制。请勿将本项目用于攻击、滥用、绕过访问控制、非法代理服务或任何违反当地法律法规及第三方平台规则的行为。

本项目不提供 Cloudflare 官方服务，不出售节点，不保证任何第三方来源的准确性、持续可用性或合法适用性。若需要稳定、商业或高频调用能力，请优先使用相关服务方提供的正式 API 或授权渠道。
