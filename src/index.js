const CACHE_KEY = "best-ip-cache";
const META_KEY = "best-ip-meta";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DEFAULT_PORTS = ["443", "8443", "2053", "2083", "2087", "2096"];
const DEFAULT_UOUIN_SOURCE = "https://api.uouin.com/index.php/index/Cloudflare";
const DEFAULT_FALLBACK_SOURCE = "https://raw.githubusercontent.com/ymyuuu/IPDB/main/bestcf.txt";
const DEFAULT_SOURCE_CHAIN = [
  DEFAULT_UOUIN_SOURCE,
  "https://www.wetest.vip/api/cf2dns/get_cloudflare_ip",
  "https://api.hostmonit.com/get_optimization_ip",
  DEFAULT_FALLBACK_SOURCE,
];
const DEFAULT_CF2DNS_KEY = "o1zrmHAF";
const UOUIN_KEY_SEED = "DdlTxtN0sUOu";
const UOUIN_KEY_SUFFIX = "70cloudflareapikey";

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/bestip.txt") {
        return handleBestIpText(env, ctx);
      }

      if (url.pathname === "/status") {
        return handleStatus(url, env);
      }

      if (url.pathname === "/refresh") {
        return handleRefresh(request, env);
      }

      if (url.pathname === "/sub" || url.pathname === "/sub/clash" || url.pathname === "/sub/mihomo") {
        return handleSubscriptionProxy(request, env, ctx);
      }

      if (url.pathname === "/" || url.pathname === "/help") {
        return jsonResponse({
          name: "preferred-ip-generator",
          routes: {
            bestIpText: "/bestip.txt",
            fixedSubscription: "/sub",
            rawSubscription: "/sub?format=raw",
            base64Subscription: "/sub?format=base64",
            autoSubscription: "/sub?format=auto",
            clashSubscription: "/sub/clash",
            mihomoSubscription: "/sub/mihomo",
            status: "/status",
            refresh: "/refresh?token=YOUR_REFRESH_TOKEN",
          },
          note:
            "Use /bestip.txt as edgetunnel TXT_URL. If SUBSCRIPTION_UPSTREAM is configured, /sub becomes a fixed subscription address, and /sub/clash or /sub/mihomo can be used by Clash-compatible clients.",
        });
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      return jsonResponse(
        {
          error: error.message,
        },
        500
      );
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(refreshPreferredIps(env, { force: true, reason: "scheduled" }));
  },
};

async function handleBestIpText(env, ctx) {
  const { payload } = await getOrRefreshCache(env, {
    preferFresh: true,
    refreshReason: "bestip-read",
  });

  return new Response(payload.txt, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function handleStatus(url, env) {
  const config = getConfig(env);
  const cached = await readJson(env.BEST_IP_KV, CACHE_KEY);
  const meta = await readJson(env.BEST_IP_KV, META_KEY);
  const cacheAgeMs = cached?.updatedAt ? Date.now() - Date.parse(cached.updatedAt) : null;
  const subscriptionLinks = config.subscriptionUpstream
    ? {
        preserve: `${url.origin}/sub`,
        raw: `${url.origin}/sub?format=raw`,
        base64: `${url.origin}/sub?format=base64`,
        auto: `${url.origin}/sub?format=auto`,
        clash: `${url.origin}/sub/clash`,
        mihomo: `${url.origin}/sub/mihomo`,
      }
    : null;

  return jsonResponse({
    sourceUrl: config.sourceUrl,
    sourceUrls: config.sourceUrls,
    perSourceLimit: config.maxResults,
    minBandwidthMb: config.minBandwidthMb,
    includeIpv6: config.includeIpv6,
    selectedPort: cached?.selectedPort ?? config.fallbackPort,
    itemCount: cached?.items?.length ?? 0,
    lastUpdatedAt: cached?.updatedAt ?? null,
    nextRefreshAfterMinutes: config.refreshIntervalMinutes,
    fixedTxtUrl: `${url.origin}/bestip.txt`,
    fixedSubscriptionUrl: config.subscriptionUpstream ? `${url.origin}/sub` : null,
    subscriptionUpstreamConfigured: Boolean(config.subscriptionUpstream),
    portProbeHost: config.portProbeHost || null,
    cacheStale: cached?.updatedAt ? isCacheStale(cached.updatedAt, config.refreshIntervalMinutes) : null,
    cacheAgeMinutes: Number.isFinite(cacheAgeMs) ? Math.round(cacheAgeMs / 60000) : null,
    sourceUsed: cached?.sourceUsed ?? cached?.sourceUrl ?? null,
    sourceSummary: cached?.sourceSummary ?? [],
    sourceFreshnessHours: config.sourceFreshnessHours,
    lastRefreshReason: meta?.reason ?? null,
    lastRefreshError: meta?.error ?? null,
    subscriptionLinks,
  });
}

async function handleRefresh(request, env) {
  const url = new URL(request.url);
  const config = getConfig(env);
  const token = url.searchParams.get("token");

  if (!config.refreshToken || token !== config.refreshToken) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }

  const payload = await refreshPreferredIps(env, { force: true, reason: "manual" });
  return jsonResponse({
    ok: true,
    updatedAt: payload.updatedAt,
    selectedPort: payload.selectedPort,
    itemCount: payload.items.length,
  });
}

async function handleSubscriptionProxy(request, env, ctx) {
  const config = getConfig(env);
  if (!config.subscriptionUpstream) {
    return jsonResponse(
      {
        error: "SUBSCRIPTION_UPSTREAM is not configured",
      },
      503
    );
  }

  const incoming = new URL(request.url);
  const routeFormat = incoming.pathname.endsWith("/clash")
    ? "clash"
    : incoming.pathname.endsWith("/mihomo")
      ? "mihomo"
      : "";
  const upstream = new URL(config.subscriptionUpstream);
  for (const [key, value] of incoming.searchParams) {
    if (key === "format") {
      continue;
    }
    upstream.searchParams.set(key, value);
  }

  const response = await fetch(upstream.toString(), {
    headers: {
      accept: request.headers.get("accept") || "*/*",
      "user-agent": USER_AGENT,
    },
  });

  const headers = cloneHeaders(response.headers, [
    "content-type",
    "content-disposition",
    "cache-control",
    "subscription-userinfo",
    "profile-update-interval",
    "profile-web-page-url",
  ]);

  if (!response.ok) {
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  }

  const upstreamBody = await response.text();
  const payload = await refreshPreferredIps(env, { force: true, reason: "sub-read" });

  const merged = mergeSubscriptionContent(upstreamBody, payload.items, config.remarkPrefix);
  const outputFormat = resolveSubscriptionFormat(request, routeFormat, merged.sourceFormat);
  const rendered = renderSubscriptionByFormat(merged, outputFormat);
  headers.set("content-type", rendered.contentType);
  if (rendered.fileName) {
    headers.set("content-disposition", `inline; filename="${rendered.fileName}"`);
  }

  return new Response(rendered.body, {
    status: response.status,
    headers,
  });
}

async function getOrRefreshCache(env, options = {}) {
  const config = getConfig(env);
  const { preferFresh = false, refreshReason = "cache-read" } = options;
  const cached = await readJson(env.BEST_IP_KV, CACHE_KEY);

  if (!cached) {
    return {
      payload: await refreshPreferredIps(env, { force: true, reason: "cold-start" }),
      stale: false,
    };
  }

  if (cacheNeedsRefresh(cached, config)) {
    return {
      payload: await refreshPreferredIps(env, { force: true, reason: `${refreshReason}-cache-upgrade` }),
      stale: false,
    };
  }

  const stale = isCacheStale(cached.updatedAt, config.refreshIntervalMinutes);
  if (stale && preferFresh) {
    return {
      payload: await refreshPreferredIps(env, { force: true, reason: refreshReason }),
      stale: false,
    };
  }

  return {
    payload: cached,
    stale,
  };
}

async function refreshPreferredIps(env, { force, reason }) {
  const config = getConfig(env);
  const existing = await readJson(env.BEST_IP_KV, CACHE_KEY);
  if (!force && existing) {
    const stillFresh =
      Date.now() - Date.parse(existing.updatedAt) <= config.refreshIntervalMinutes * 60_000;
    if (stillFresh) {
      return existing;
    }
  }

  try {
    const selectedPort = await selectPort(config);
    const resolved = await resolvePreferredItems(config, selectedPort);
    const items = resolved.rows.map((row, index) => finalizeRow(row, selectedPort, config.remarkPrefix, index));
    const txt = items.map((item) => formatTxtLine(item)).join("\n");

    const payload = {
      updatedAt: new Date().toISOString(),
      selectedPort,
      sourceUrl: resolved.sources[0]?.sourceUrl ?? config.sourceUrl,
      sourceUsed: resolved.sources.map((item) => item.sourceUrl),
      sourceType: resolved.sources.map((item) => item.sourceType),
      sourceSummary: resolved.sources,
      minBandwidthMb: config.minBandwidthMb,
      itemCount: items.length,
      items,
      txt,
    };

    await env.BEST_IP_KV.put(CACHE_KEY, JSON.stringify(payload));
    await env.BEST_IP_KV.put(
      META_KEY,
      JSON.stringify({
        updatedAt: payload.updatedAt,
        reason,
        error: null,
      })
    );

    return payload;
  } catch (error) {
    await env.BEST_IP_KV.put(
      META_KEY,
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        reason,
        error: error.message,
      })
    );

    if (existing) {
      return existing;
    }

    throw error;
  }
}

function getConfig(env) {
  const sourceUrl = normalizeUrlValue(env.SOURCE_URL || DEFAULT_SOURCE_CHAIN[0]);
  const sourceUrls = splitList(env.SOURCE_URLS || "")
    .map((item) => normalizeUrlValue(item))
    .filter(Boolean);

  return {
    sourceUrl,
    sourceUrls: sourceUrls.length > 0 ? sourceUrls : DEFAULT_SOURCE_CHAIN,
    maxResults: Math.max(1, toNumber(env.MAX_RESULTS, 10)),
    minBandwidthMb: Math.max(0, toNumber(env.MIN_BANDWIDTH_MB, 20)),
    includeIpv6: toBoolean(env.INCLUDE_IPV6, false),
    lineAllowlist: splitList(env.LINE_ALLOWLIST),
    portCandidates: splitList(env.PORT_CANDIDATES).length
      ? splitList(env.PORT_CANDIDATES)
      : DEFAULT_PORTS,
    fallbackPort: String(env.FALLBACK_PORT || "443"),
    refreshIntervalMinutes: Math.max(1, toNumber(env.REFRESH_INTERVAL_MINUTES, 30)),
    remarkPrefix: env.REMARK_PREFIX || "CF",
    portProbeHost: (env.PORT_PROBE_HOST || "").trim(),
    subscriptionUpstream: (env.SUBSCRIPTION_UPSTREAM || "").trim(),
    refreshToken: (env.REFRESH_TOKEN || "").trim(),
    sourceFreshnessHours: Math.max(1, toNumber(env.SOURCE_FRESHNESS_HOURS, 24)),
    cf2dnsKey: (env.CF2DNS_KEY || DEFAULT_CF2DNS_KEY).trim(),
  };
}

async function fetchSource(sourceUrl, config) {
  const request = buildSourceRequest(sourceUrl, config);
  const response = await fetch(request.url, request.options);

  if (!response.ok) {
    throw new Error(`Fetch source failed: ${response.status}`);
  }

  return {
    text: await response.text(),
    contentType: response.headers.get("content-type") || "",
  };
}

function buildSourceRequest(sourceUrl, config) {
  if (isUouinCloudflareSource(sourceUrl)) {
    const timestamp = Date.now();
    const key = md5Hex(`${md5Hex(UOUIN_KEY_SEED)}${UOUIN_KEY_SUFFIX}${timestamp}`);
    const url = new URL(DEFAULT_UOUIN_SOURCE);
    url.searchParams.set("key", key);
    url.searchParams.set("time", String(timestamp));

    return {
      url: url.toString(),
      options: {
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/json,text/plain,*/*",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          referer: "https://api.uouin.com/cloudflare.html",
          "x-requested-with": "XMLHttpRequest",
          "cache-control": "no-cache, no-store, max-age=0",
          pragma: "no-cache",
        },
        cf: {
          cacheEverything: false,
          cacheTtl: 0,
        },
      },
    };
  }

  if (isCf2DnsApiSource(sourceUrl)) {
    return {
      url: sourceUrl,
      options: {
        method: "POST",
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/json,text/plain,*/*",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          "cache-control": "no-cache, no-store, max-age=0",
          pragma: "no-cache",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          key: config.cf2dnsKey,
          type: config.includeIpv6 ? "v6" : "v4",
        }),
        cf: {
          cacheEverything: false,
          cacheTtl: 0,
        },
      },
    };
  }

  return {
    url: sourceUrl,
    options: {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/plain,application/json;q=0.9,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "cache-control": "no-cache, no-store, max-age=0",
        pragma: "no-cache",
      },
      cf: {
        cacheEverything: false,
        cacheTtl: 0,
      },
    },
  };
}

function isCf2DnsApiSource(sourceUrl) {
  return /wetest\.vip\/api\/cf2dns\/get_cloudflare_ip|hostmonit\.com\/get_optimization_ip|smognode1\.top\/api\/cf2dns\/cloudflare_ip/i.test(
    sourceUrl
  );
}

function isUouinCloudflareSource(sourceUrl) {
  try {
    const url = new URL(sourceUrl);
    return (
      url.hostname === "api.uouin.com" &&
      (/\/index\.php\/index\/cloudflare$/i.test(url.pathname) || /\/cloudflare\.html$/i.test(url.pathname))
    );
  } catch {
    return false;
  }
}

function sourceLabelFromUrl(sourceUrl) {
  const normalized = String(sourceUrl || "").toLowerCase();
  if (normalized.includes("api.uouin.com")) return "Uouin";
  if (normalized.includes("wetest.vip")) return "WeTest";
  if (normalized.includes("hostmonit.com")) return "HostMonit";
  if (normalized.includes("smognode1.top")) return "Smognode1";
  if (normalized.includes("raw.githubusercontent.com")) return "GitHubRaw";
  return "Source";
}

async function selectPort(config) {
  if (!config.portProbeHost) {
    return config.fallbackPort;
  }

  const probeResults = await Promise.all(
    config.portCandidates.map(async (port) => ({
      port,
      latency: await probePort(config.portProbeHost, port),
    }))
  );

  const available = probeResults
    .filter((item) => Number.isFinite(item.latency))
    .sort((left, right) => left.latency - right.latency);

  return available[0]?.port || config.fallbackPort;
}

async function probePort(host, port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), 3500);
  const startedAt = Date.now();

  try {
    const response = await fetch(`https://${host}:${port}/cdn-cgi/trace`, {
      headers: {
        "user-agent": USER_AGENT,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return Number.POSITIVE_INFINITY;
    }

    return Date.now() - startedAt;
  } catch {
    return Number.POSITIVE_INFINITY;
  } finally {
    clearTimeout(timeout);
  }
}

function buildRemark(row, prefix, index) {
  const tokens = [
    prefix,
    row.sourceName,
    row.line,
    formatBandwidthToken(row.bandwidthMb),
    formatLatencyToken(row.latencyMs),
    `${index + 1}`,
  ];
  return tokens.map(sanitizeRemarkToken).filter(Boolean).join("-");
}

function formatTxtLine(item) {
  const host = item.ip.includes(":") ? `[${item.ip}]` : item.ip;
  return `${host}:${item.port}#${item.remark}`;
}

async function resolvePreferredItems(config, selectedPort) {
  const errors = [];
  const sources = [];
  const rows = [];
  const seenEndpoints = new Set();

  for (const sourceUrl of config.sourceUrls) {
    try {
      const response = await fetchSource(sourceUrl, config);
      const parsed = parseSourceResponse(response.text, response.contentType, sourceUrl, config);
      const selectedRows = selectRowsForSource(parsed.rows, config, parsed.sourceName);
      if (selectedRows.length === 0) {
        throw new Error("No IPs match the current filter");
      }

      let appendedCount = 0;
      for (const row of selectedRows) {
        const endpointKey = buildEndpointKey(row.ip, row.port || selectedPort);
        if (seenEndpoints.has(endpointKey)) {
          continue;
        }
        seenEndpoints.add(endpointKey);
        rows.push(row);
        appendedCount += 1;
      }

      if (appendedCount === 0) {
        continue;
      }

      sources.push({
        sourceUrl,
        sourceType: parsed.sourceType,
        sourceName: parsed.sourceName,
        selectionMode: parsed.selectionMode,
        itemCount: appendedCount,
      });
    } catch (error) {
      errors.push(`${sourceUrl}: ${error.message}`);
    }
  }

  if (rows.length === 0) {
    throw new Error(`All sources failed. ${errors.join(" | ")}`);
  }

  return {
    sources,
    rows,
  };
}

function parseSourceResponse(body, contentType, sourceUrl, config) {
  const normalizedContentType = String(contentType || "").toLowerCase();
  if (normalizedContentType.includes("application/json") || looksLikeJsonBody(body)) {
    const rows = parseJsonIpList(body, sourceUrl);
    const sourceType = detectJsonSourceType(body, sourceUrl);
    return ensureRowsFresh(rows, sourceUrl, config, sourceType, sourceLabelFromUrl(sourceUrl));
  }

  const rows = parsePlainIpList(body);
  return ensureRowsFresh(rows, sourceUrl, config, "plain-ip-list", sourceLabelFromUrl(sourceUrl));
}

function detectJsonSourceType(body, sourceUrl) {
  try {
    const payload = JSON.parse(body);
    if (isUouinCloudflarePayload(payload, sourceUrl)) {
      return "uouin-cloudflare-json";
    }

    if (isCf2DnsPayload(payload, sourceUrl)) {
      return "cf2dns-json";
    }
  } catch {}
  return "json-ip-list";
}

function ensureRowsFresh(rows, sourceUrl, config, sourceType, sourceName) {
  if (rows.length === 0) {
    throw new Error(`Source returned no valid rows (${sourceType})`);
  }

  const datedRows = rows
    .map((row) => ({
      row,
      timestampMs: parseSourceTimestamp(row.timestamp),
    }))
    .filter((item) => Number.isFinite(item.timestampMs));

  if (datedRows.length > 0) {
    const newestTimestampMs = Math.max(...datedRows.map((item) => item.timestampMs));
    const ageHours = (Date.now() - newestTimestampMs) / 3_600_000;
    if (ageHours > config.sourceFreshnessHours) {
      throw new Error(
        `Source data is stale (${Math.round(ageHours)}h old, limit ${config.sourceFreshnessHours}h)`
      );
    }
  }

  return {
    sourceType,
    sourceName,
    selectionMode: rows.some((row) => row.hasBandwidthField) ? "bandwidth" : "latency",
    rows,
  };
}

function selectRowsForSource(rows, config, sourceName) {
  const unique = new Map();
  const sourceHasBandwidthField = rows.some((row) => row.hasBandwidthField);

  for (const row of rows) {
    if (!config.includeIpv6 && row.ip.includes(":")) {
      continue;
    }

    if (config.lineAllowlist.length > 0 && !config.lineAllowlist.includes(row.line)) {
      continue;
    }

    if (
      sourceHasBandwidthField &&
      config.minBandwidthMb > 0 &&
      (!Number.isFinite(row.bandwidthMb) || row.bandwidthMb <= config.minBandwidthMb)
    ) {
      continue;
    }

    if (!unique.has(row.ip)) {
      unique.set(row.ip, {
        ...row,
        sourceName,
      });
    }
  }

  const normalizedRows = [...unique.values()];
  const hasBandwidthField = normalizedRows.some((row) => row.hasBandwidthField);
  const sortedRows = normalizedRows.sort((left, right) => {
    if (hasBandwidthField) {
      const rightBandwidth = Number.isFinite(right.bandwidthMb) ? right.bandwidthMb : -1;
      const leftBandwidth = Number.isFinite(left.bandwidthMb) ? left.bandwidthMb : -1;
      if (rightBandwidth !== leftBandwidth) {
        return rightBandwidth - leftBandwidth;
      }
    }

    const leftLatency = Number.isFinite(left.latencyMs) ? left.latencyMs : Number.POSITIVE_INFINITY;
    const rightLatency = Number.isFinite(right.latencyMs) ? right.latencyMs : Number.POSITIVE_INFINITY;
    if (leftLatency !== rightLatency) {
      return leftLatency - rightLatency;
    }

    const rightSpeed = Number.isFinite(right.speedMbPerSecond) ? right.speedMbPerSecond : -1;
    const leftSpeed = Number.isFinite(left.speedMbPerSecond) ? left.speedMbPerSecond : -1;
    if (rightSpeed !== leftSpeed) {
      return rightSpeed - leftSpeed;
    }

    return String(left.ip).localeCompare(String(right.ip));
  });

  return sortedRows.slice(0, config.maxResults);
}

function parsePlainIpList(body) {
  const rows = [];
  for (const rawLine of String(body || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const [endpointPart, remarkPart = ""] = line.split("#");
    const endpoint = endpointPart.trim();
    const parsed = parseEndpoint(endpoint);
    if (!parsed || !looksLikeIp(parsed.ip)) {
      continue;
    }

    rows.push({
      rank: rows.length + 1,
      line: extractLineFromRemark(remarkPart) || "fallback",
      ip: parsed.ip,
      port: parsed.port,
      loss: "",
      latencyMs: Number.NaN,
      speedMbPerSecond: Number.NaN,
      bandwidthMb: parseBandwidthFromRemark(remarkPart),
      timestamp: "",
      sourceRemark: remarkPart.trim(),
      hasBandwidthField: false,
    });
  }

  return rows;
}

function parseJsonIpList(body, sourceUrl) {
  const payload = JSON.parse(body);
  const uouinRows = parseUouinCloudflarePayload(payload, sourceUrl);
  if (uouinRows.length > 0) {
    return uouinRows;
  }

  const cf2dnsRows = parseCf2DnsPayload(payload, sourceUrl);
  if (cf2dnsRows.length > 0) {
    return cf2dnsRows;
  }

  const values = Array.isArray(payload) ? payload : payload?.data || payload?.ips || payload?.result || [];
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((entry, index) => {
      const value = typeof entry === "string" ? entry : entry?.ip || entry?.address || "";
      const parsed = parseEndpoint(String(value).trim());
      if (!parsed || !looksLikeIp(parsed.ip)) {
        return null;
      }

      return {
        rank: index + 1,
        line: typeof entry === "object" ? entry?.line_name || entry?.line || "fallback" : "fallback",
        ip: parsed.ip,
        port: parsed.port,
        loss: "",
        latencyMs: Number.NaN,
        speedMbPerSecond: Number.NaN,
        bandwidthMb:
          typeof entry === "object" ? toNumber(entry?.bandwidth ?? entry?.speed, Number.NaN) : Number.NaN,
        timestamp: typeof entry === "object" ? String(entry?.uptime || entry?.timestamp || "") : "",
        sourceRemark: typeof entry === "object" ? String(entry?.colo || "") : "",
        hasBandwidthField: Boolean(typeof entry === "object" && entry && "bandwidth" in entry),
      };
    })
    .filter(Boolean);
}

function parseUouinCloudflarePayload(payload, sourceUrl) {
  if (!isUouinCloudflarePayload(payload, sourceUrl)) {
    return [];
  }

  const buckets = payload?.data || {};
  const rows = [];
  for (const [bucketName, bucket] of Object.entries(buckets)) {
    if (!bucket || !Array.isArray(bucket.info)) {
      continue;
    }

    for (const entry of bucket.info) {
      const parsed = parseEndpoint(String(entry?.ip || entry?.address || "").trim());
      if (!parsed || !looksLikeIp(parsed.ip)) {
        continue;
      }

      rows.push({
        rank: rows.length + 1,
        line: normalizeProviderLineName(lineNameFromUouinBucket(bucketName)),
        ip: parsed.ip,
        port: parsed.port,
        loss: String(entry?.loss_rate ?? entry?.loss ?? ""),
        latencyMs: toNumber(entry?.rtt_avg ?? entry?.latency ?? entry?.ping, Number.NaN),
        speedMbPerSecond: toNumber(entry?.speed, Number.NaN),
        bandwidthMb: toNumber(entry?.bandwidth, Number.NaN),
        timestamp: String(entry?.updated_at || entry?.time || entry?.timestamp || bucket.uptime || ""),
        sourceRemark: String(entry?.colo || entry?.node || bucketName),
        hasBandwidthField: Boolean(entry && Object.prototype.hasOwnProperty.call(entry, "bandwidth")),
      });
    }
  }

  return rows;
}

function isUouinCloudflarePayload(payload, sourceUrl) {
  if (!isUouinCloudflareSource(sourceUrl)) {
    return false;
  }

  const data = payload?.data;
  return Boolean(
    data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      Object.values(data).some((bucket) => bucket && Array.isArray(bucket.info))
  );
}

function lineNameFromUouinBucket(bucketName) {
  const normalized = String(bucketName || "").toLowerCase();
  if (normalized === "bgp") return "BGP";
  if (normalized === "ctcc") return "CT";
  if (normalized === "cmcc") return "CM";
  if (normalized === "cucc") return "CU";
  if (normalized === "ipv6") return "IPv6";
  return bucketName || "fallback";
}

function parseCf2DnsPayload(payload, sourceUrl) {
  if (!isCf2DnsPayload(payload, sourceUrl)) {
    return [];
  }

  const infoBuckets = payload?.info || payload?.data?.info || payload?.data || {};
  const rows = [];
  for (const [bucketName, entries] of Object.entries(infoBuckets)) {
    if (!Array.isArray(entries)) {
      continue;
    }

    for (const entry of entries) {
      const parsed = parseEndpoint(String(entry?.ip || entry?.address || "").trim());
      if (!parsed || !looksLikeIp(parsed.ip)) {
        continue;
      }

      rows.push({
        rank: rows.length + 1,
        line: normalizeProviderLineName(entry?.line_name || entry?.line || bucketName),
        ip: parsed.ip,
        port: parsed.port,
        loss: String(entry?.loss_rate ?? entry?.loss ?? ""),
        latencyMs: toNumber(entry?.rtt_avg ?? entry?.latency ?? entry?.ping, Number.NaN),
        speedMbPerSecond: toNumber(entry?.speed, Number.NaN),
        bandwidthMb: normalizeProviderBandwidth(entry),
        timestamp: String(entry?.updated_at || entry?.time || entry?.timestamp || ""),
        sourceRemark: String(entry?.colo || entry?.node || entry?.type || ""),
        hasBandwidthField: Boolean(entry && Object.prototype.hasOwnProperty.call(entry, "bandwidth")),
      });
    }
  }

  return rows;
}

function isCf2DnsPayload(payload, sourceUrl) {
  if (isCf2DnsApiSource(sourceUrl)) {
    return true;
  }

  const info = payload?.info || payload?.data?.info || payload?.data;
  return Boolean(info && typeof info === "object" && !Array.isArray(info));
}

function normalizeProviderLineName(value) {
  const raw = String(value || "").trim();
  const upper = raw.toUpperCase();
  if (upper.includes("CM") || raw.includes("移动")) return "移动";
  if (upper.includes("CU") || raw.includes("联通")) return "联通";
  if (upper.includes("CT") || raw.includes("电信")) return "电信";
  if (upper.includes("BGP") || raw.includes("多线")) return "多线";
  if (upper.includes("V6")) return "IPv6";
  return raw || "fallback";
}

function normalizeProviderBandwidth(entry) {
  const speed = toNumber(entry?.speed, Number.NaN);
  const bandwidth = toNumber(entry?.bandwidth, Number.NaN);

  if (Number.isFinite(speed) && Number.isFinite(bandwidth) && bandwidth <= 10 && speed >= 100) {
    return speed;
  }

  return Number.isFinite(bandwidth) ? bandwidth : Number.NaN;
}

function finalizeRow(row, selectedPort, remarkPrefix, index) {
  const port = row.port || selectedPort;
  return {
    ...row,
    port,
    remark: buildRemark({ ...row, port }, remarkPrefix, index),
  };
}

function parseEndpoint(input) {
  if (!input) {
    return null;
  }

  const bracketed = input.match(/^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i);
  if (bracketed) {
    return { ip: bracketed[1], port: bracketed[2] || "" };
  }

  const ipv4WithPort = input.match(/^((?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?$/);
  if (ipv4WithPort) {
    return { ip: ipv4WithPort[1], port: ipv4WithPort[2] || "" };
  }

  const ipv6Only = input.match(/^([0-9a-f:]+)$/i);
  if (ipv6Only) {
    return { ip: ipv6Only[1], port: "" };
  }

  return null;
}

function normalizeUrlValue(value) {
  return String(value || "")
    .trim()
    .replace(/^['"`\s]+|['"`\s]+$/g, "");
}

function extractLineFromRemark(remark) {
  const upper = String(remark || "").toUpperCase();
  if (upper.includes("CT")) return "电信";
  if (upper.includes("CU")) return "联通";
  if (upper.includes("CM")) return "移动";
  return "";
}

function parseBandwidthFromRemark(remark) {
  const match = String(remark || "").match(/(\d+(?:\.\d+)?)\s*M/i);
  return match ? Number.parseFloat(match[1]) : Number.NaN;
}

function parseSourceTimestamp(value) {
  if (!value) {
    return Number.NaN;
  }

  if (/^\d{10}$/.test(String(value).trim())) {
    return Number.parseInt(String(value).trim(), 10) * 1000;
  }

  const normalized = String(value).trim().replace(/\//g, "-");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function formatBandwidthToken(value) {
  return Number.isFinite(value) ? `${Math.round(value)}MB` : "NA";
}

function formatLatencyToken(value) {
  return Number.isFinite(value) ? `${Math.round(value)}MS` : "NA";
}

function isCacheStale(updatedAt, refreshIntervalMinutes) {
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return true;
  }

  return Date.now() - updatedAtMs > refreshIntervalMinutes * 60_000;
}

function cacheNeedsRefresh(cached, config) {
  if (!cached || !Array.isArray(cached.items) || cached.items.length === 0) {
    return true;
  }

  if (!cached.sourceUsed && !cached.sourceUrl) {
    return true;
  }

  const normalizedSources = config.sourceUrls.map((item) => normalizeUrlValue(item));
  const usedSources = Array.isArray(cached.sourceUsed)
    ? cached.sourceUsed
    : [cached.sourceUsed || cached.sourceUrl].filter(Boolean);
  if (usedSources.some((item) => !normalizedSources.includes(normalizeUrlValue(item)))) {
    return true;
  }

  if (toNumber(cached.minBandwidthMb, 0) !== config.minBandwidthMb) {
    return true;
  }

  return false;
}

function mergeSubscriptionContent(upstreamBody, preferredItems, remarkPrefix) {
  const decoded = tryDecodeBase64Subscription(upstreamBody);
  const workingBody = decoded?.body ?? upstreamBody;
  const originalLines = splitSubscriptionLines(workingBody);
  const preservedLines = originalLines.filter((line) => {
    const parsed = parseSubscriptionUri(line);
    return !parsed || !isManagedPreferredNode(parsed.url, remarkPrefix);
  });
  const parsedLinks = preservedLines.map((line) => parseSubscriptionUri(line)).filter(Boolean);

  if (parsedLinks.length === 0 || preferredItems.length === 0) {
    const body = preservedLines.join("\n");
    return {
      body,
      encodedBody: encodeBase64Utf8(body),
      sourceFormat: decoded ? "base64" : "raw",
      addedCount: 0,
    };
  }

  const existingLineSet = new Set(preservedLines);
  const existingEndpointSet = new Set(
    parsedLinks.map((item) => buildEndpointKey(item.url.hostname, item.url.port || defaultPortForScheme(item.url)))
  );
  const templateLink = selectTemplateLink(parsedLinks);
  const additions = [];

  if (!templateLink) {
    const body = preservedLines.join("\n");
    return {
      body,
      encodedBody: encodeBase64Utf8(body),
      sourceFormat: decoded ? "base64" : "raw",
      addedCount: 0,
    };
  }

  for (const preferredItem of preferredItems) {
    const endpointKey = buildEndpointKey(preferredItem.ip, preferredItem.port);
    if (existingEndpointSet.has(endpointKey)) {
      continue;
    }

    const nextLine = cloneSubscriptionUri(templateLink, preferredItem, remarkPrefix);
    if (!existingLineSet.has(nextLine)) {
      existingLineSet.add(nextLine);
      additions.push(nextLine);
      existingEndpointSet.add(endpointKey);
    }
  }

  const mergedLines = additions.length > 0 ? [...preservedLines, ...additions] : preservedLines;
  const body = mergedLines.join("\n");
  return {
    body,
    encodedBody: encodeBase64Utf8(body),
    sourceFormat: decoded ? "base64" : "raw",
    addedCount: additions.length,
  };
}

function resolveSubscriptionFormat(request, routeFormat, sourceFormat) {
  const url = new URL(request.url);
  const requested = normalizeSubscriptionFormat(url.searchParams.get("format") || routeFormat);
  if (!requested) {
    return sourceFormat;
  }
  if (requested === "auto") {
    return detectAutoSubscriptionFormat(request, sourceFormat);
  }
  return requested;
}

function normalizeSubscriptionFormat(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["raw", "base64", "clash", "mihomo", "auto"].includes(normalized)) {
    return normalized;
  }
  return "";
}

function detectAutoSubscriptionFormat(request, sourceFormat) {
  const userAgent = String(request.headers.get("user-agent") || "").toLowerCase();
  const accept = String(request.headers.get("accept") || "").toLowerCase();
  if (
    /(clash|verge|mihomo|meta|stash|nekobox)/.test(userAgent) ||
    /yaml|yml|application\/x-yaml|text\/yaml/.test(accept)
  ) {
    return "clash";
  }
  return sourceFormat;
}

function renderSubscriptionByFormat(merged, format) {
  if (format === "base64") {
    return {
      body: merged.encodedBody,
      contentType: "text/plain; charset=utf-8",
      fileName: "subscription.txt",
    };
  }

  if (format === "clash" || format === "mihomo") {
    return {
      body: buildClashSubscriptionYaml(merged.body),
      contentType: "text/yaml; charset=utf-8",
      fileName: `subscription-${format}.yaml`,
    };
  }

  return {
    body: merged.body,
    contentType: "text/plain; charset=utf-8",
    fileName: "subscription.txt",
  };
}

function tryDecodeBase64Subscription(input) {
  const compact = input.trim().replace(/\s+/g, "");
  if (!compact || compact.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(compact)) {
    return null;
  }

  try {
    const body = decodeBase64Utf8(compact);
    const lines = splitSubscriptionLines(body);
    const hasLinks = lines.some((line) => isSubscriptionUri(line));
    return hasLinks ? { body } : null;
  } catch {
    return null;
  }
}

function splitSubscriptionLines(body) {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseSubscriptionUri(line) {
  if (!isSubscriptionUri(line)) {
    return null;
  }

  try {
    return {
      line,
      url: new URL(line),
    };
  } catch {
    return null;
  }
}

function isSubscriptionUri(line) {
  return /^(vless|vmess|trojan|ss):\/\//i.test(line);
}

function buildClashSubscriptionYaml(body) {
  const parsedLinks = splitSubscriptionLines(body)
    .map((line) => parseSubscriptionUri(line))
    .filter(Boolean);
  const usedNames = new Set();
  const proxies = parsedLinks
    .map((item) => convertUriToClashProxy(item, usedNames))
    .filter(Boolean);

  if (proxies.length === 0) {
    throw new Error("No supported nodes can be converted to Clash format");
  }

  const proxyNames = proxies.map((item) => item.name);
  const document = {
    mode: "rule",
    proxies,
    "proxy-groups": [
      {
        name: "PROXY",
        type: "select",
        proxies: ["AUTO", "DIRECT", ...proxyNames],
      },
      {
        name: "AUTO",
        type: "url-test",
        url: "https://www.gstatic.com/generate_204",
        interval: 300,
        tolerance: 50,
        proxies: proxyNames,
      },
    ],
    rules: ["MATCH,PROXY"],
  };

  return renderYaml(document);
}

function convertUriToClashProxy(parsed, usedNames) {
  const scheme = parsed.url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme === "vless") {
    return convertVlessUriToClashProxy(parsed, usedNames);
  }
  if (scheme === "trojan") {
    return convertTrojanUriToClashProxy(parsed, usedNames);
  }
  return null;
}

function convertVlessUriToClashProxy(parsed, usedNames) {
  const { url } = parsed;
  const searchParams = url.searchParams;
  const network = normalizeClashNetwork(searchParams.get("type") || "tcp");
  const security = String(searchParams.get("security") || "").toLowerCase();
  const host = searchParams.get("host") || "";
  const path = safeDecodeUrlComponent(searchParams.get("path") || "");
  const proxy = {
    name: makeUniqueProxyName(extractSubscriptionName(url), usedNames),
    type: "vless",
    server: url.hostname,
    port: Number.parseInt(url.port || "443", 10),
    uuid: safeDecodeUrlComponent(url.username),
    network,
    udp: true,
  };

  if (searchParams.get("flow")) {
    proxy.flow = searchParams.get("flow");
  }

  if (security === "tls" || security === "reality") {
    proxy.tls = true;
    proxy.servername = searchParams.get("sni") || host || url.hostname;
  }

  if (searchParams.get("alpn")) {
    proxy.alpn = splitList(searchParams.get("alpn"));
  }

  if (searchParams.get("fp")) {
    proxy["client-fingerprint"] = searchParams.get("fp");
  }

  if (searchParams.get("allowInsecure") === "1") {
    proxy["skip-cert-verify"] = true;
  }

  if (security === "reality") {
    proxy["reality-opts"] = {
      "public-key": searchParams.get("pbk") || "",
    };
    if (searchParams.get("sid")) {
      proxy["reality-opts"]["short-id"] = searchParams.get("sid");
    }
    if (searchParams.get("spx")) {
      proxy["reality-opts"]["spider-x"] = safeDecodeUrlComponent(searchParams.get("spx"));
    }
  }

  if (network === "ws") {
    proxy["ws-opts"] = {
      path: path || "/",
    };
    if (host) {
      proxy["ws-opts"].headers = {
        Host: host,
      };
    }
  }

  if (network === "grpc") {
    proxy["grpc-opts"] = {};
    if (searchParams.get("serviceName")) {
      proxy["grpc-opts"]["grpc-service-name"] = searchParams.get("serviceName");
    }
  }

  if (network === "http") {
    proxy["http-opts"] = {
      method: "GET",
      path: [path || "/"],
    };
    if (host) {
      proxy["http-opts"].headers = {
        Host: [host],
      };
    }
  }

  return proxy;
}

function convertTrojanUriToClashProxy(parsed, usedNames) {
  const { url } = parsed;
  const searchParams = url.searchParams;
  const network = normalizeClashNetwork(searchParams.get("type") || "tcp");
  const host = searchParams.get("host") || "";
  const path = safeDecodeUrlComponent(searchParams.get("path") || "");
  const proxy = {
    name: makeUniqueProxyName(extractSubscriptionName(url), usedNames),
    type: "trojan",
    server: url.hostname,
    port: Number.parseInt(url.port || "443", 10),
    password: safeDecodeUrlComponent(url.username),
    network,
    udp: true,
  };

  if (searchParams.get("sni") || host) {
    proxy.sni = searchParams.get("sni") || host;
  }

  if (searchParams.get("allowInsecure") === "1") {
    proxy["skip-cert-verify"] = true;
  }

  if (searchParams.get("alpn")) {
    proxy.alpn = splitList(searchParams.get("alpn"));
  }

  if (network === "ws") {
    proxy["ws-opts"] = {
      path: path || "/",
    };
    if (host) {
      proxy["ws-opts"].headers = {
        Host: host,
      };
    }
  }

  if (network === "grpc") {
    proxy["grpc-opts"] = {};
    if (searchParams.get("serviceName")) {
      proxy["grpc-opts"]["grpc-service-name"] = searchParams.get("serviceName");
    }
  }

  return proxy;
}

function extractSubscriptionName(url) {
  return safeDecodeUrlComponent(url.hash.replace(/^#/, "")) || `${url.protocol.replace(/:$/, "")}-${url.hostname}`;
}

function makeUniqueProxyName(name, usedNames) {
  const baseName = String(name || "proxy").trim() || "proxy";
  let nextName = baseName;
  let suffix = 2;
  while (usedNames.has(nextName)) {
    nextName = `${baseName}-${suffix}`;
    suffix += 1;
  }
  usedNames.add(nextName);
  return nextName;
}

function normalizeClashNetwork(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "h2" || normalized === "http") {
    return "http";
  }
  if (normalized === "httpupgrade") {
    return "ws";
  }
  if (["tcp", "ws", "grpc"].includes(normalized)) {
    return normalized;
  }
  return "tcp";
}

function renderYaml(value, indent = 0) {
  const prefix = "  ".repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${prefix}[]`;
    }
    return value
      .map((item) => {
        if (isYamlScalar(item)) {
          return `${prefix}- ${renderYamlScalar(item)}`;
        }
        return `${prefix}-\n${renderYaml(item, indent + 1)}`;
      })
      .join("\n");
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined && item !== null);
    if (entries.length === 0) {
      return `${prefix}{}`;
    }
    return entries
      .map(([key, item]) => {
        if (isYamlScalar(item)) {
          return `${prefix}${key}: ${renderYamlScalar(item)}`;
        }
        return `${prefix}${key}:\n${renderYaml(item, indent + 1)}`;
      })
      .join("\n");
  }

  return `${prefix}${renderYamlScalar(value)}`;
}

function isYamlScalar(value) {
  return typeof value !== "object" || value === null;
}

function renderYamlScalar(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : '""';
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return JSON.stringify(String(value ?? ""));
}

function selectTemplateLink(parsedLinks) {
  return parsedLinks[0] || null;
}

function buildTemplateKey(url) {
  const params = [...url.searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey)
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return [
    url.protocol,
    url.username,
    url.password,
    url.pathname,
    params,
  ].join("|");
}

function cloneSubscriptionUri(template, preferredItem, remarkPrefix) {
  const nextUrl = new URL(template.line);
  nextUrl.hostname = preferredItem.ip;
  nextUrl.port = String(preferredItem.port);

  const managedRemark = [
    buildManagedRemarkPrefix(remarkPrefix, preferredItem.sourceName),
    preferredItem.ip,
    formatBandwidthToken(preferredItem.bandwidthMb),
    formatLatencyToken(preferredItem.latencyMs),
  ].join(" | ");
  nextUrl.hash = managedRemark;
  return nextUrl.toString();
}

function buildEndpointKey(hostname, port) {
  return `${hostname}|${String(port || "").trim()}`;
}

function isManagedPreferredNode(url, remarkPrefix) {
  const remark = safeDecodeUrlComponent(url.hash.replace(/^#/, ""));
  return remark.startsWith("AUTO-") || remark.startsWith(buildManagedRemarkPrefix(remarkPrefix));
}

function buildManagedRemarkPrefix(remarkPrefix, sourceName = "") {
  const normalized = sanitizeRemarkToken(sourceName || remarkPrefix || "CF") || "CF";
  return `AUTO-${normalized}`;
}

function defaultPortForScheme(url) {
  return url.protocol === "http:" ? "80" : "443";
}

function decodeBase64Utf8(input) {
  const binary = atob(input);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(input) {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function safeDecodeUrlComponent(input) {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

function normalizeText(input) {
  return decodeHtml(stripHtml(input)).replace(/\s+/g, " ").trim();
}

function stripHtml(input) {
  return input
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ");
}

function decodeHtml(input) {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function looksLikeJsonBody(input) {
  const trimmed = String(input || "").trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function parseSizeToMb(text) {
  const match = text.toLowerCase().match(/([\d.]+)\s*(kb|mb|gb|tb)/i);
  if (!match) {
    return 0;
  }

  const value = Number.parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const scale = {
    kb: 1 / 1024,
    mb: 1,
    gb: 1024,
    tb: 1024 * 1024,
  };
  return value * (scale[unit] || 1);
}

function looksLikeIp(value) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value) || /^[0-9a-f:]+$/i.test(value);
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toNumber(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function sanitizeRemarkToken(value) {
  return String(value)
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function md5Hex(input) {
  const bytes = new TextEncoder().encode(String(input));
  const words = [];
  for (let index = 0; index < bytes.length; index += 1) {
    words[index >> 2] = (words[index >> 2] || 0) | (bytes[index] << ((index % 4) * 8));
  }

  words[bytes.length >> 2] = (words[bytes.length >> 2] || 0) | (0x80 << ((bytes.length % 4) * 8));
  words[(((bytes.length + 8) >> 6) << 4) + 14] = bytes.length * 8;

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  for (let index = 0; index < words.length; index += 16) {
    const aa = a;
    const bb = b;
    const cc = c;
    const dd = d;

    a = md5Ff(a, b, c, d, words[index] || 0, 7, 0xd76aa478);
    d = md5Ff(d, a, b, c, words[index + 1] || 0, 12, 0xe8c7b756);
    c = md5Ff(c, d, a, b, words[index + 2] || 0, 17, 0x242070db);
    b = md5Ff(b, c, d, a, words[index + 3] || 0, 22, 0xc1bdceee);
    a = md5Ff(a, b, c, d, words[index + 4] || 0, 7, 0xf57c0faf);
    d = md5Ff(d, a, b, c, words[index + 5] || 0, 12, 0x4787c62a);
    c = md5Ff(c, d, a, b, words[index + 6] || 0, 17, 0xa8304613);
    b = md5Ff(b, c, d, a, words[index + 7] || 0, 22, 0xfd469501);
    a = md5Ff(a, b, c, d, words[index + 8] || 0, 7, 0x698098d8);
    d = md5Ff(d, a, b, c, words[index + 9] || 0, 12, 0x8b44f7af);
    c = md5Ff(c, d, a, b, words[index + 10] || 0, 17, 0xffff5bb1);
    b = md5Ff(b, c, d, a, words[index + 11] || 0, 22, 0x895cd7be);
    a = md5Ff(a, b, c, d, words[index + 12] || 0, 7, 0x6b901122);
    d = md5Ff(d, a, b, c, words[index + 13] || 0, 12, 0xfd987193);
    c = md5Ff(c, d, a, b, words[index + 14] || 0, 17, 0xa679438e);
    b = md5Ff(b, c, d, a, words[index + 15] || 0, 22, 0x49b40821);

    a = md5Gg(a, b, c, d, words[index + 1] || 0, 5, 0xf61e2562);
    d = md5Gg(d, a, b, c, words[index + 6] || 0, 9, 0xc040b340);
    c = md5Gg(c, d, a, b, words[index + 11] || 0, 14, 0x265e5a51);
    b = md5Gg(b, c, d, a, words[index] || 0, 20, 0xe9b6c7aa);
    a = md5Gg(a, b, c, d, words[index + 5] || 0, 5, 0xd62f105d);
    d = md5Gg(d, a, b, c, words[index + 10] || 0, 9, 0x02441453);
    c = md5Gg(c, d, a, b, words[index + 15] || 0, 14, 0xd8a1e681);
    b = md5Gg(b, c, d, a, words[index + 4] || 0, 20, 0xe7d3fbc8);
    a = md5Gg(a, b, c, d, words[index + 9] || 0, 5, 0x21e1cde6);
    d = md5Gg(d, a, b, c, words[index + 14] || 0, 9, 0xc33707d6);
    c = md5Gg(c, d, a, b, words[index + 3] || 0, 14, 0xf4d50d87);
    b = md5Gg(b, c, d, a, words[index + 8] || 0, 20, 0x455a14ed);
    a = md5Gg(a, b, c, d, words[index + 13] || 0, 5, 0xa9e3e905);
    d = md5Gg(d, a, b, c, words[index + 2] || 0, 9, 0xfcefa3f8);
    c = md5Gg(c, d, a, b, words[index + 7] || 0, 14, 0x676f02d9);
    b = md5Gg(b, c, d, a, words[index + 12] || 0, 20, 0x8d2a4c8a);

    a = md5Hh(a, b, c, d, words[index + 5] || 0, 4, 0xfffa3942);
    d = md5Hh(d, a, b, c, words[index + 8] || 0, 11, 0x8771f681);
    c = md5Hh(c, d, a, b, words[index + 11] || 0, 16, 0x6d9d6122);
    b = md5Hh(b, c, d, a, words[index + 14] || 0, 23, 0xfde5380c);
    a = md5Hh(a, b, c, d, words[index + 1] || 0, 4, 0xa4beea44);
    d = md5Hh(d, a, b, c, words[index + 4] || 0, 11, 0x4bdecfa9);
    c = md5Hh(c, d, a, b, words[index + 7] || 0, 16, 0xf6bb4b60);
    b = md5Hh(b, c, d, a, words[index + 10] || 0, 23, 0xbebfbc70);
    a = md5Hh(a, b, c, d, words[index + 13] || 0, 4, 0x289b7ec6);
    d = md5Hh(d, a, b, c, words[index] || 0, 11, 0xeaa127fa);
    c = md5Hh(c, d, a, b, words[index + 3] || 0, 16, 0xd4ef3085);
    b = md5Hh(b, c, d, a, words[index + 6] || 0, 23, 0x04881d05);
    a = md5Hh(a, b, c, d, words[index + 9] || 0, 4, 0xd9d4d039);
    d = md5Hh(d, a, b, c, words[index + 12] || 0, 11, 0xe6db99e5);
    c = md5Hh(c, d, a, b, words[index + 15] || 0, 16, 0x1fa27cf8);
    b = md5Hh(b, c, d, a, words[index + 2] || 0, 23, 0xc4ac5665);

    a = md5Ii(a, b, c, d, words[index] || 0, 6, 0xf4292244);
    d = md5Ii(d, a, b, c, words[index + 7] || 0, 10, 0x432aff97);
    c = md5Ii(c, d, a, b, words[index + 14] || 0, 15, 0xab9423a7);
    b = md5Ii(b, c, d, a, words[index + 5] || 0, 21, 0xfc93a039);
    a = md5Ii(a, b, c, d, words[index + 12] || 0, 6, 0x655b59c3);
    d = md5Ii(d, a, b, c, words[index + 3] || 0, 10, 0x8f0ccc92);
    c = md5Ii(c, d, a, b, words[index + 10] || 0, 15, 0xffeff47d);
    b = md5Ii(b, c, d, a, words[index + 1] || 0, 21, 0x85845dd1);
    a = md5Ii(a, b, c, d, words[index + 8] || 0, 6, 0x6fa87e4f);
    d = md5Ii(d, a, b, c, words[index + 15] || 0, 10, 0xfe2ce6e0);
    c = md5Ii(c, d, a, b, words[index + 6] || 0, 15, 0xa3014314);
    b = md5Ii(b, c, d, a, words[index + 13] || 0, 21, 0x4e0811a1);
    a = md5Ii(a, b, c, d, words[index + 4] || 0, 6, 0xf7537e82);
    d = md5Ii(d, a, b, c, words[index + 11] || 0, 10, 0xbd3af235);
    c = md5Ii(c, d, a, b, words[index + 2] || 0, 15, 0x2ad7d2bb);
    b = md5Ii(b, c, d, a, words[index + 9] || 0, 21, 0xeb86d391);

    a = md5Add(a, aa);
    b = md5Add(b, bb);
    c = md5Add(c, cc);
    d = md5Add(d, dd);
  }

  return [a, b, c, d].map(md5WordToHex).join("");
}

function md5RotateLeft(value, shift) {
  return (value << shift) | (value >>> (32 - shift));
}

function md5Add(left, right) {
  return (left + right) | 0;
}

function md5Cmn(q, a, b, x, s, t) {
  return md5Add(md5RotateLeft(md5Add(md5Add(a, q), md5Add(x, t)), s), b);
}

function md5Ff(a, b, c, d, x, s, t) {
  return md5Cmn((b & c) | (~b & d), a, b, x, s, t);
}

function md5Gg(a, b, c, d, x, s, t) {
  return md5Cmn((b & d) | (c & ~d), a, b, x, s, t);
}

function md5Hh(a, b, c, d, x, s, t) {
  return md5Cmn(b ^ c ^ d, a, b, x, s, t);
}

function md5Ii(a, b, c, d, x, s, t) {
  return md5Cmn(c ^ (b | ~d), a, b, x, s, t);
}

function md5WordToHex(value) {
  let output = "";
  for (let index = 0; index < 4; index += 1) {
    output += (`0${((value >>> (index * 8)) & 0xff).toString(16)}`).slice(-2);
  }
  return output;
}

async function readJson(kv, key) {
  const raw = await kv.get(key);
  return raw ? JSON.parse(raw) : null;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function cloneHeaders(source, allowlist) {
  const headers = new Headers();
  for (const key of allowlist) {
    const value = source.get(key);
    if (value) {
      headers.set(key, value);
    }
  }
  return headers;
}
