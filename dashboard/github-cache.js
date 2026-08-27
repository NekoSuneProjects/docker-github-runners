'use strict';

// Shared process-wide GitHub REST cache for the dashboard.
// The dashboard has several layers (overview, realtime, runner controls) and
// multiple browser tabs can hit them at the same time. Without a shared cache,
// identical GitHub GET requests can quickly exhaust a PAT's REST quota.

const nativeFetch = globalThis.fetch.bind(globalThis);
const responseCache = new Map();
const inFlight = new Map();

const clamp = (value, min, max) => Math.max(min, Math.min(Number(value) || min, max));
const BASE_TTL_MS = clamp(process.env.DASHBOARD_GITHUB_CACHE_SECONDS || 30, 10, 600) * 1000;
const RUNS_TTL_MS = clamp(process.env.DASHBOARD_GITHUB_RUNS_CACHE_SECONDS || 60, 15, 600) * 1000;
const JOBS_TTL_MS = clamp(process.env.DASHBOARD_GITHUB_JOBS_CACHE_SECONDS || 30, 10, 300) * 1000;
const RUNNER_TTL_MS = clamp(process.env.DASHBOARD_GITHUB_RUNNERS_CACHE_SECONDS || 30, 10, 300) * 1000;
const REPOS_TTL_MS = clamp(process.env.DASHBOARD_GITHUB_REPOS_CACHE_SECONDS || 300, 30, 1800) * 1000;
const STALE_MS = clamp(process.env.DASHBOARD_GITHUB_STALE_SECONDS || 900, 60, 7200) * 1000;
const RATE_RESERVE = clamp(process.env.DASHBOARD_GITHUB_RATE_RESERVE || 500, 0, 4000);
const MAX_CACHE_ENTRIES = clamp(process.env.DASHBOARD_GITHUB_CACHE_MAX_ENTRIES || 500, 50, 2000);
const MAX_CACHE_BODY = 4 * 1024 * 1024;

let rateRemaining = null;
let rateLimit = null;
let rateResetAt = 0;
let blockedUntil = 0;
let lastRateLog = '';

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input && typeof input.url === 'string' ? input.url : '';
}

function requestMethod(input, init) {
  return String(init?.method || input?.method || 'GET').toUpperCase();
}

function isCacheableGithubGet(url, method) {
  if (method !== 'GET' || !url.startsWith('https://api.github.com/')) return false;
  // Workflow log downloads redirect to blob storage and can be very large or
  // temporarily unavailable. Keep them out of the metadata cache.
  if (/\/actions\/runs\/\d+\/logs(?:\?|$)/.test(url)) return false;
  if (/\/actions\/jobs\/\d+\/logs(?:\?|$)/.test(url)) return false;
  return true;
}

function ttlFor(url) {
  if (/\/orgs\/[^/]+\/repos(?:\?|$)/.test(url)) return REPOS_TTL_MS;
  if (/\/orgs\/[^/]+\/actions\/runners(?:\?|$)/.test(url)) return RUNNER_TTL_MS;
  if (/\/actions\/runs\/\d+\/jobs(?:\?|$)/.test(url)) return JOBS_TTL_MS;
  if (/\/actions\/runs(?:\?|$)/.test(url)) return RUNS_TTL_MS;
  if (/\/actions\/runs\/\d+(?:\?|$)/.test(url)) return BASE_TTL_MS;
  return BASE_TTL_MS;
}

function pressureMultiplier() {
  if (!Number.isFinite(rateRemaining)) return 1;
  if (rateRemaining <= Math.max(100, RATE_RESERVE / 4)) return 6;
  if (rateRemaining <= RATE_RESERVE) return 4;
  if (rateRemaining <= RATE_RESERVE * 2) return 2;
  return 1;
}

function responseFrom(entry, cacheState = 'hit') {
  const headers = new Headers(entry.headers);
  headers.set('x-neko-github-cache', cacheState);
  if (Number.isFinite(rateRemaining)) headers.set('x-neko-github-rate-remaining', String(rateRemaining));
  if (rateResetAt) headers.set('x-neko-github-rate-reset', String(Math.floor(rateResetAt / 1000)));
  return new Response(entry.body.slice(0), {
    status: entry.status,
    statusText: entry.statusText,
    headers,
  });
}

function updateRate(headers) {
  const remaining = Number(headers.get('x-ratelimit-remaining'));
  const limit = Number(headers.get('x-ratelimit-limit'));
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(remaining)) rateRemaining = remaining;
  if (Number.isFinite(limit)) rateLimit = limit;
  if (Number.isFinite(reset) && reset > 0) rateResetAt = reset * 1000;

  if (Number.isFinite(rateRemaining) && rateRemaining <= RATE_RESERVE) {
    const msg = `${rateRemaining}/${rateLimit || '?'} until ${rateResetAt ? new Date(rateResetAt).toISOString() : 'reset'}`;
    if (msg !== lastRateLog) {
      console.warn(`[github-cache] GitHub API quota low: ${msg}; extending cache TTLs.`);
      lastRateLog = msg;
    }
  }
}

function isRateLimited(status, headers, bodyText) {
  const remaining = Number(headers.get('x-ratelimit-remaining'));
  return status === 429 ||
    (status === 403 && (remaining === 0 || /rate limit exceeded/i.test(bodyText)));
}

function trimCache() {
  while (responseCache.size > MAX_CACHE_ENTRIES) {
    const first = responseCache.keys().next().value;
    if (first === undefined) break;
    responseCache.delete(first);
  }
}

function syntheticRateLimitedResponse(url) {
  const resetText = blockedUntil ? new Date(blockedUntil).toISOString() : 'the next GitHub reset';
  const body = JSON.stringify({
    message: `GitHub API quota is exhausted. Dashboard requests are paused until ${resetText} instead of repeatedly hitting GitHub.`,
    cached_by_dashboard: true,
    url,
  });
  return new Response(body, {
    status: 429,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-neko-github-cache': 'rate-limited',
    },
  });
}

async function fetchAndStore(input, init, key, url) {
  const response = await nativeFetch(input, init);
  const body = Buffer.from(await response.arrayBuffer());
  updateRate(response.headers);
  const bodyText = body.toString('utf8', 0, Math.min(body.length, 2048));

  if (isRateLimited(response.status, response.headers, bodyText)) {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    blockedUntil = Number.isFinite(reset) && reset > 0
      ? Math.max(Date.now() + 30_000, reset * 1000 + 5_000)
      : Date.now() + 5 * 60_000;

    const stale = responseCache.get(key);
    if (stale && Date.now() - stale.storedAt <= STALE_MS) {
      console.warn(`[github-cache] Rate limit reached; serving stale cached GitHub data for ${new URL(url).pathname}.`);
      return { entry: stale, cacheState: 'stale-rate-limit' };
    }

    return {
      response: new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    };
  }

  const entry = {
    body,
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()),
    storedAt: Date.now(),
    expiresAt: Date.now() + ttlFor(url) * pressureMultiplier(),
  };

  if (response.ok && body.length <= MAX_CACHE_BODY) {
    responseCache.delete(key);
    responseCache.set(key, entry);
    trimCache();
  }

  return { entry, cacheState: response.ok ? 'miss' : 'pass' };
}

globalThis.fetch = async function nekoRateAwareFetch(input, init = {}) {
  const url = requestUrl(input);
  const method = requestMethod(input, init);
  if (!isCacheableGithubGet(url, method)) return nativeFetch(input, init);

  const accept = String(init?.headers?.Accept || init?.headers?.accept || '');
  const key = `${method} ${url} accept=${accept}`;
  const now = Date.now();
  const cached = responseCache.get(key);

  if (cached && cached.expiresAt > now) return responseFrom(cached, 'hit');

  if (blockedUntil > now) {
    if (cached && now - cached.storedAt <= STALE_MS) return responseFrom(cached, 'stale-rate-limit');
    return syntheticRateLimitedResponse(url);
  }

  let pending = inFlight.get(key);
  if (!pending) {
    pending = fetchAndStore(input, init, key, url);
    inFlight.set(key, pending);
  }

  try {
    const result = await pending;
    if (result.response) return result.response;
    return responseFrom(result.entry, result.cacheState);
  } finally {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  }
};

globalThis.__NEKO_GITHUB_CACHE__ = {
  stats() {
    return {
      entries: responseCache.size,
      in_flight: inFlight.size,
      rate_remaining: rateRemaining,
      rate_limit: rateLimit,
      rate_reset_at: rateResetAt ? new Date(rateResetAt).toISOString() : null,
      blocked_until: blockedUntil ? new Date(blockedUntil).toISOString() : null,
    };
  },
};

console.log(`[github-cache] enabled: base=${BASE_TTL_MS / 1000}s runs=${RUNS_TTL_MS / 1000}s jobs=${JOBS_TTL_MS / 1000}s runners=${RUNNER_TTL_MS / 1000}s stale=${STALE_MS / 1000}s`);
