# Preferred IP Generator

一个基于 Cloudflare Worker 的轻量工具，用于：

- 从 `https://api.uouin.com/cloudflare.html` 抓取优选 IP
- 按带宽阈值过滤并生成稳定的优选 IP 列表
- 在保留上游原始订阅的前提下，增量追加优选 IP 节点
- 提供固定的订阅访问地址，便于客户端长期使用

这个项目适合已经有上游订阅服务，但缺少“稳定优选入口”和“定时刷新能力”的场景。

## 功能概览

- `GET /bestip.txt`
  输出当前筛选后的优选 IP 列表，格式为 `IP:端口#备注`

- `GET /sub`
  读取上游原始订阅，保留原节点，再按当前优选 IP 增量追加新节点

- `GET /status`
  查看最近刷新时间、当前端口、缓存状态和错误信息

- `GET /refresh?token=...`
  手动触发一次刷新

## 核心设计

### 1. 不覆盖原订阅

`/sub` 不会替换原始订阅里的 IP，而是：

1. 读取上游原始订阅
2. 解析其中的 URI 节点
3. 以现有节点为模板，仅替换为新优选 IP
4. 自动跳过已存在的 `IP:端口`
5. 将新增节点追加到原订阅末尾

这样可以兼顾：

- 原始订阅完整保留
- 新优选节点持续补充
- 固定订阅入口不变

### 2. 端口策略

项目默认使用 Cloudflare 常见 TLS 端口候选：

```text
443,8443,2053,2083,2087,2096
```

如果设置了 `PORT_PROBE_HOST`，Worker 会尝试在候选端口中选择可用且响应更快的端口；否则直接使用 `FALLBACK_PORT`。

### 3. 轻迁移

仓库内不包含任何真实 KV ID、订阅地址或刷新 token，便于公开上传、Fork 和迁移部署。

## 目录结构

```text
.
├─ src/
│  └─ index.js
├─ .dev.vars.example
├─ .gitignore
├─ package.json
├─ package-lock.json
├─ README.md
└─ wrangler.toml
```

## 配置项

`wrangler.toml` 已提供模板，部署前请自行替换占位值：

- `BEST_IP_KV`
  Cloudflare KV 绑定，必须填写真实 `id` 和 `preview_id`

- `SOURCE_URL`
  优选 IP 来源，默认 `https://api.uouin.com/cloudflare.html`

- `BANDWIDTH_THRESHOLD_MB`
  最低带宽阈值，默认 `100`

- `MAX_RESULTS`
  最多输出多少个优选 IP，默认 `20`

- `INCLUDE_IPV6`
  是否包含 IPv6，默认 `false`

- `LINE_ALLOWLIST`
  可选，仅保留指定线路，例如 `电信,多线`

- `PORT_CANDIDATES`
  候选端口列表

- `FALLBACK_PORT`
  无法探测端口时使用的兜底端口，默认 `443`

- `REFRESH_INTERVAL_MINUTES`
  刷新周期，默认 `30`

- `REMARK_PREFIX`
  新增节点备注前缀，默认 `CF`

- `PORT_PROBE_HOST`
  用于端口探测的域名，可留空

- `SUBSCRIPTION_UPSTREAM`
  上游原始订阅地址，`/sub` 依赖该项工作

- `REFRESH_TOKEN`
  手动刷新密钥，用于 `/refresh`

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 登录 Cloudflare

```bash
npx wrangler login
```

### 3. 创建 KV

```bash
npx wrangler kv namespace create BEST_IP_KV
npx wrangler kv namespace create BEST_IP_KV --preview
```

将返回的 `id` 和 `preview_id` 写入 `wrangler.toml`。

### 4. 填写变量

至少需要配置：

- `SUBSCRIPTION_UPSTREAM`
- `REFRESH_TOKEN`

如需本地调试，可以复制 `.dev.vars.example` 为 `.dev.vars` 后填写。

### 5. 部署

```bash
npx wrangler deploy
```

部署完成后通常会得到两个固定地址：

```text
https://<your-worker-domain>/bestip.txt
https://<your-worker-domain>/sub
```

## 迁移说明

如果你要将本项目迁移到新的 GitHub 仓库或新环境，请按以下顺序操作：

1. 克隆或下载仓库
2. 执行 `npm install`
3. 在 Cloudflare 账号中新建 KV Namespace
4. 修改 `wrangler.toml` 中的 KV ID 占位值
5. 填写 `SUBSCRIPTION_UPSTREAM` 与 `REFRESH_TOKEN`
6. 执行 `npx wrangler deploy`

只要保持 Worker 域名不变，客户端订阅地址就不需要更改。

## 调试建议

优先检查以下接口：

- `/status`
- `/bestip.txt`
- `/sub`

如果订阅已获取但客户端无法工作，先排查本地代理软件端口冲突，而不是优先怀疑订阅内容本身。

## 安全提示

- 不要将真实的 `SUBSCRIPTION_UPSTREAM`、`REFRESH_TOKEN`、KV ID 提交到公开仓库
- 建议使用 `.dev.vars` 或 Cloudflare 环境变量保存敏感信息
- 上传前请再次检查 `wrangler.toml` 是否仍然保留占位符
