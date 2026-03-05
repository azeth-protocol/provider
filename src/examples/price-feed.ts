import { AzethError } from '@azeth/common';

/** Supported CoinGecko coin identifiers */
const SUPPORTED_COINS = [
  'bitcoin',
  'ethereum',
  'solana',
  'usd-coin',
  'chainlink',
  'aave',
  'uniswap',
  'maker',
  'compound-governance-token',
] as const;

export type SupportedCoinId = (typeof SUPPORTED_COINS)[number];

/** Price data returned by the service */
export interface PriceData {
  coinId: string;
  price: number;
  currency: string;
  timestamp: number;
  source: 'coingecko';
}

interface CacheEntry {
  data: PriceData;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60_000; // 60 seconds
const MAX_CACHE_ENTRIES = 100;
const FETCH_TIMEOUT_MS = 10_000;
const FORCE_REFRESH_COOLDOWN_MS = 10_000; // 1 per coin per 10s

const priceCache = new Map<string, CacheEntry>();
const lastForceRefresh = new Map<string, number>();

/** Check if a coin ID is in the supported whitelist */
export function isSupportedCoin(coinId: string): coinId is SupportedCoinId {
  return (SUPPORTED_COINS as readonly string[]).includes(coinId);
}

/** Build a cache key from coin ID and currency */
function cacheKey(coinId: string, currency: string): string {
  return `${coinId}:${currency}`;
}

/** Fetch a price from CoinGecko */
async function fetchFromCoinGecko(coinId: string, currency: string): Promise<PriceData> {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=${encodeURIComponent(currency)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AzethError('CoinGecko request timed out', 'NETWORK_ERROR', {
        coinId,
        timeoutMs: FETCH_TIMEOUT_MS,
      });
    }
    // TimeoutError from AbortSignal.timeout
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new AzethError('CoinGecko request timed out', 'NETWORK_ERROR', {
        coinId,
        timeoutMs: FETCH_TIMEOUT_MS,
      });
    }
    throw new AzethError('CoinGecko request failed', 'NETWORK_ERROR', {
      coinId,
      detail: err instanceof Error ? err.message : 'Unknown error',
    });
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    throw new AzethError('CoinGecko rate limit exceeded', 'NETWORK_ERROR', {
      coinId,
      retryAfterSeconds: retryAfter ? parseInt(retryAfter, 10) : 60,
    });
  }

  if (!response.ok) {
    throw new AzethError('CoinGecko returned error', 'NETWORK_ERROR', {
      coinId,
      status: response.status,
    });
  }

  const json = (await response.json()) as Record<string, Record<string, number>>;
  const coinData = json[coinId];
  const price = coinData?.[currency];

  if (typeof price !== 'number') {
    throw new AzethError('Malformed CoinGecko response', 'NETWORK_ERROR', {
      coinId,
      detail: `Missing price for ${coinId} in ${currency}`,
    });
  }

  return {
    coinId,
    price,
    currency,
    timestamp: Math.floor(Date.now() / 1000),
    source: 'coingecko',
  };
}

/** Evict the oldest cache entry if at capacity */
function evictIfNeeded(): void {
  if (priceCache.size >= MAX_CACHE_ENTRIES) {
    // Evict oldest entry
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [k, v] of priceCache) {
      if (v.fetchedAt < oldestTime) {
        oldestTime = v.fetchedAt;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) priceCache.delete(oldestKey);
  }
}

/** Get a price with caching. Returns cached data if within TTL, otherwise fetches fresh.
 *  On fetch failure, returns stale cache if available (stale-on-error). */
export async function getPrice(coinId: SupportedCoinId, currency: string = 'usd'): Promise<PriceData> {
  const key = cacheKey(coinId, currency);
  const cached = priceCache.get(key);
  const now = Date.now();

  // Cache hit — within TTL
  if (cached && (now - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.data;
  }

  // Cache miss or stale — fetch fresh
  try {
    const data = await fetchFromCoinGecko(coinId, currency);
    evictIfNeeded();
    priceCache.set(key, { data, fetchedAt: now });
    return data;
  } catch (err: unknown) {
    // Stale-on-error: return stale cache if available
    if (cached) {
      return cached.data;
    }
    throw err;
  }
}

/** Bypass cache and fetch fresh data. Rate-limited to 1 per coin per 10 seconds. */
export async function getFreshPrice(coinId: SupportedCoinId, currency: string = 'usd'): Promise<PriceData> {
  const key = cacheKey(coinId, currency);
  const now = Date.now();

  // Rate limit: 1 fresh fetch per coin per 10s
  const lastRefresh = lastForceRefresh.get(key);
  if (lastRefresh && (now - lastRefresh) < FORCE_REFRESH_COOLDOWN_MS) {
    // Fall back to cached or regular fetch
    return getPrice(coinId, currency);
  }

  lastForceRefresh.set(key, now);

  const data = await fetchFromCoinGecko(coinId, currency);
  evictIfNeeded();
  priceCache.set(key, { data, fetchedAt: now });
  return data;
}

/** Clear all cached data (for tests) */
export function clearPriceCache(): void {
  priceCache.clear();
  lastForceRefresh.clear();
}
