# Preferred IP Generator

[中文](README.md)

A Cloudflare Workers utility for aggregating IP sources and transforming subscriptions. It implements per-source filtering, deduplication, KV caching, and `bestip.txt` and subscription outputs. Source-reported latency or bandwidth is not a measurement of the user's connection by this project.

## Current boundary

**Subscription routes currently have no application-level authentication.** `REFRESH_TOKEN` protects only `/refresh`, not `/sub`, `/sub/clash`, or `/sub/mihomo`. A publicly reachable deployment with a private `SUBSCRIPTION_UPSTREAM` exposes its subscription content to callers of these routes. For an existing public deployment, first remove `SUBSCRIPTION_UPSTREAM` to disable subscription proxying, or block unauthorized access at the gateway. Put appropriate access control in place before attaching a private subscription. Hiding the repository or configuration does not protect a running endpoint.

This is a personal configuration utility without a systematic cross-region performance or availability evaluation. Web endpoints, signature mechanisms, and default access parameters may change; their presence does not establish permission for continuing or commercial access.

## Behavior and interfaces

- Sources with a `bandwidth` field use `MIN_BANDWIDTH_MB`, default 20. The source defines the unit and measurement method.
- Other sources are ordered by reported latency, with at most 10 entries per source by default.
- IPv4 is included by default; IPv6 is configurable. Text entries use `IP:port#remark`.
- Subscription conversion retains upstream nodes and replaces previously appended `AUTO-source` managed nodes.

| Endpoint | Purpose |
| --- | --- |
| `GET /bestip.txt` | Current IP list |
| `GET /sub` | Read configured upstream subscription and refresh managed nodes |
| `GET /sub/clash`, `/sub/mihomo` | YAML outputs |
| `GET /sub?format=raw\|base64\|clash\|mihomo\|auto` | Select format |
| `GET /status` | Cache, sources, refresh errors, and subscription endpoint status |
| `GET /refresh?token=...` | Token-protected manual refresh |

Default sources are [Uouin](https://api.uouin.com/index.php/index/Cloudflare), [WeTest](https://www.wetest.vip/api/cf2dns/get_cloudflare_ip), [HostMonit](https://api.hostmonit.com/get_optimization_ip), and [IPDB](https://github.com/ymyuuu/IPDB). Uouin access follows its web-page loading signature mechanism; this project does not maintain that API.

## Configuration and deployment

Copy `.dev.vars.example` to local `.dev.vars`. Keep production credentials in Worker secrets or equivalent protected configuration. Do not commit subscription URLs, tokens, or live deployment configuration.

| Variable | Meaning |
| --- | --- |
| `SOURCE_URL`, `SOURCE_URLS` | Single or comma-separated sources |
| `MAX_RESULTS`, `MIN_BANDWIDTH_MB` | Per-source limit and bandwidth threshold |
| `INCLUDE_IPV6`, `LINE_ALLOWLIST` | IPv6 and line filters |
| `PORT_CANDIDATES`, `FALLBACK_PORT` | Candidate and fallback ports |
| `REFRESH_INTERVAL_MINUTES`, `SOURCE_FRESHNESS_HOURS` | Refresh interval and source staleness limit |
| `REMARK_PREFIX`, `PORT_PROBE_HOST` | Remark prefix and optional probe host |
| `CF2DNS_KEY` | Source access parameter |
| `SUBSCRIPTION_UPSTREAM` | Private upstream; requires the access control described above |
| `REFRESH_TOKEN` | Manual refresh authentication only |

```bash
npm install
npx wrangler login
npx wrangler kv namespace create BEST_IP_KV
npx wrangler kv namespace create BEST_IP_KV --preview
```

Set the returned KV identifiers in local `wrangler.toml`, review access control and source conditions, then run `npx wrangler deploy`. See [src/index.js](src/index.js).

## Evidence and licensing

The implementation defines filtering, caching, and conversion. “Preferred” does not establish better performance for every provider, region, or time. Evaluation should retain source timestamps, location, repeated measurements, failure rates, and a matched connection baseline. No top-level `LICENSE` is currently supplied. Third-party access and redistribution conditions apply separately. This project is not officially affiliated with Cloudflare or the source services.
