const CACHE_KEY = "best-ip-cache";
const META_KEY = "best-ip-meta";
const USER_AGENT = "preferred-ip-generator/1.0";
const DEFAULT_PORTS = ["443", "8443", "2053", "2083", "2087", "2096"];

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

      if (url.pathname === "/sub") {
        return handleSubscriptionProxy(request, env, ctx);
      }

      if (url.pathname === "/" || url.pathname === "/help") {
        return jsonResponse({
          name: "preferred-ip-generator",
          routes: {
            bestIpText: "/bestip.txt",
            fixedSubscription: "/sub",
            status: "/status",
            refresh: "/refresh?token=YOUR_REFRESH_TOKEN",
          },
          note:
            "Use /bestip.txt as edgetunnel TXT_URL. If SUBSCRIPTION_UPSTREAM is configured, /sub becomes a fixed subscription address.",
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
  const { payload, stale } = await getOrRefreshCache(env);
  if (stale) {
    ctx.waitUntil(refreshPreferredIps(env, { force: true, reason: "stale-read" }));
  }

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

  return jsonResponse({
    sourceUrl: config.sourceUrl,
    thresholdMb: config.bandwidthThresholdMb,
    maxResults: config.maxResults,
    includeIpv6: config.includeIpv6,
    selectedPort: cached?.selectedPort ?? config.fallbackPort,
    itemCount: cached?.items?.length ?? 0,
    lastUpdatedAt: cached?.updatedAt ?? null,
    nextRefreshAfterMinutes: config.refreshIntervalMinutes,
    fixedTxtUrl: `${url.origin}/bestip.txt`,
    fixedSubscriptionUrl: config.subscriptionUpstream ? `${url.origin}/sub` : null,
    subscriptionUpstreamConfigured: Boolean(config.subscriptionUpstream),
    portProbeHost: config.portProbeHost || null,
    lastRefreshReason: meta?.reason ?? null,
    lastRefreshError: meta?.error ?? null,
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
  const upstream = new URL(config.subscriptionUpstream);
  for (const [key, value] of incoming.searchParams) {
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
  const { payload, stale } = await getOrRefreshCache(env);
  if (stale) {
    ctx.waitUntil(refreshPreferredIps(env, { force: true, reason: "stale-sub-read" }));
  }

  const merged = mergeSubscriptionContent(upstreamBody, payload.items, config.remarkPrefix);
  headers.set("content-type", "text/plain; charset=utf-8");

  return new Response(merged.body, {
    status: response.status,
    headers,
  });
}

async function getOrRefreshCache(env) {
  const config = getConfig(env);
  const cached = await readJson(env.BEST_IP_KV, CACHE_KEY);

  if (!cached) {
    return {
      payload: await refreshPreferredIps(env, { force: true, reason: "cold-start" }),
      stale: false,
    };
  }

  const stale = Date.now() - Date.parse(cached.updatedAt) > config.refreshIntervalMinutes * 60_000;
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
    const html = await fetchSourceHtml(config.sourceUrl);
    const parsedRows = parseUouinTable(html);
    const filteredRows = filterRows(parsedRows, config);
    if (filteredRows.length === 0) {
      throw new Error("No IPs match the current filter");
    }

    const selectedPort = await selectPort(config);
    const items = filteredRows.slice(0, config.maxResults).map((row, index) => ({
      ...row,
      port: selectedPort,
      remark: buildRemark(row, config.remarkPrefix, index),
    }));
    const txt = items.map((item) => formatTxtLine(item)).join("\n");

    const payload = {
      updatedAt: new Date().toISOString(),
      selectedPort,
      sourceUrl: config.sourceUrl,
      thresholdMb: config.bandwidthThresholdMb,
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
  return {
    sourceUrl: env.SOURCE_URL || "https://api.uouin.com/cloudflare.html",
    bandwidthThresholdMb: toNumber(env.BANDWIDTH_THRESHOLD_MB, 100),
    maxResults: toNumber(env.MAX_RESULTS, 20),
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
  };
}

async function fetchSourceHtml(sourceUrl) {
  const response = await fetch(sourceUrl, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch source failed: ${response.status}`);
  }

  return response.text();
}

function parseUouinTable(html) {
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/i)?.[1] ?? html;
  const rows = [];
  const rowPattern = /<tr>([\s\S]*?)<\/tr>/gi;

  for (const rowMatch of tbody.matchAll(rowPattern)) {
    const rowHtml = rowMatch[1];
    const cells = [...rowHtml.matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((match) =>
      normalizeText(match[2])
    );

    if (cells.length < 9 || !looksLikeIp(cells[2])) {
      continue;
    }

    rows.push({
      rank: toNumber(cells[0], 0),
      line: cells[1],
      ip: cells[2],
      loss: cells[3],
      latencyMs: toNumber(cells[4].replace(/ms/gi, ""), 0),
      speedMbPerSecond: parseSizeToMb(cells[5]),
      bandwidthMb: parseSizeToMb(cells[6]),
      timestamp: cells[8],
    });
  }

  return rows;
}

function filterRows(rows, config) {
  const unique = new Map();

  for (const row of rows) {
    if (!config.includeIpv6 && row.ip.includes(":")) {
      continue;
    }

    if (row.bandwidthMb < config.bandwidthThresholdMb) {
      continue;
    }

    if (config.lineAllowlist.length > 0 && !config.lineAllowlist.includes(row.line)) {
      continue;
    }

    if (!unique.has(row.ip)) {
      unique.set(row.ip, row);
    }
  }

  return [...unique.values()].sort((left, right) => {
    if (right.bandwidthMb !== left.bandwidthMb) {
      return right.bandwidthMb - left.bandwidthMb;
    }
    return left.latencyMs - right.latencyMs;
  });
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
    row.line,
    `${Math.round(row.bandwidthMb)}MB`,
    `${Math.round(row.latencyMs)}MS`,
    `${index + 1}`,
  ];
  return tokens.map(sanitizeRemarkToken).filter(Boolean).join("-");
}

function formatTxtLine(item) {
  const host = item.ip.includes(":") ? `[${item.ip}]` : item.ip;
  return `${host}:${item.port}#${item.remark}`;
}

function mergeSubscriptionContent(upstreamBody, preferredItems, remarkPrefix) {
  const decoded = tryDecodeBase64Subscription(upstreamBody);
  const workingBody = decoded?.body ?? upstreamBody;
  const originalLines = splitSubscriptionLines(workingBody);
  const parsedLinks = originalLines
    .map((line) => parseSubscriptionUri(line))
    .filter(Boolean);

  if (parsedLinks.length === 0 || preferredItems.length === 0) {
    return {
      body: decoded ? encodeBase64Utf8(workingBody) : workingBody,
      format: decoded ? "base64" : "plain",
      addedCount: 0,
    };
  }

  const existingLineSet = new Set(originalLines);
  const existingEndpointSet = new Set(
    parsedLinks.map((item) => buildEndpointKey(item.url.hostname, item.url.port || defaultPortForScheme(item.url)))
  );
  const templateLinks = selectTemplateLinks(parsedLinks);
  const additions = [];

  for (const template of templateLinks) {
    for (const preferredItem of preferredItems) {
      const endpointKey = buildEndpointKey(preferredItem.ip, preferredItem.port);
      if (existingEndpointSet.has(endpointKey)) {
        continue;
      }

      const nextLine = cloneSubscriptionUri(template, preferredItem, remarkPrefix);
      if (!existingLineSet.has(nextLine)) {
        existingLineSet.add(nextLine);
        additions.push(nextLine);
      }
    }
  }

  const mergedLines = additions.length > 0 ? [...originalLines, ...additions] : originalLines;
  const mergedBody = mergedLines.join("\n");
  return {
    body: decoded ? encodeBase64Utf8(mergedBody) : mergedBody,
    format: decoded ? "base64" : "plain",
    addedCount: additions.length,
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

function selectTemplateLinks(parsedLinks) {
  const uniqueTemplates = new Map();

  for (const item of parsedLinks) {
    const key = buildTemplateKey(item.url);
    if (!uniqueTemplates.has(key)) {
      uniqueTemplates.set(key, item);
    }
  }

  return [...uniqueTemplates.values()];
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

  const originalRemark = safeDecodeUrlComponent(nextUrl.hash.replace(/^#/, ""));
  const additionRemark = [
    remarkPrefix,
    preferredItem.ip,
    `${Math.round(preferredItem.bandwidthMb || 0)}MB`,
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join("-");
  const mergedRemark = [originalRemark, additionRemark].filter(Boolean).join(" | ");
  nextUrl.hash = mergedRemark;
  return nextUrl.toString();
}

function buildEndpointKey(hostname, port) {
  return `${hostname}|${String(port || "").trim()}`;
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
