import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AzethError } from '@azeth/common';
import {
  getPrice,
  getFreshPrice,
  clearPriceCache,
  isSupportedCoin,
} from '../../src/examples/price-feed.js';

/** Build a valid CoinGecko response */
function coinGeckoResponse(coinId: string, price: number, currency: string = 'usd') {
  return { [coinId]: { [currency]: price } };
}

describe('Price Feed Service', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearPriceCache();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── isSupportedCoin ──

  describe('isSupportedCoin', () => {
    it('should return true for supported coins', () => {
      expect(isSupportedCoin('bitcoin')).toBe(true);
      expect(isSupportedCoin('ethereum')).toBe(true);
      expect(isSupportedCoin('solana')).toBe(true);
      expect(isSupportedCoin('usd-coin')).toBe(true);
    });

    it('should return false for unsupported coins', () => {
      expect(isSupportedCoin('dogecoin')).toBe(false);
      expect(isSupportedCoin('')).toBe(false);
      expect(isSupportedCoin('BITCOIN')).toBe(false);
    });
  });

  // ── Cache behavior ──

  describe('caching', () => {
    it('should return cached data within TTL without re-fetching', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(coinGeckoResponse('bitcoin', 98234.56)),
      });

      const first = await getPrice('bitcoin');
      const second = await getPrice('bitcoin');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(first.price).toBe(98234.56);
      expect(second.price).toBe(98234.56);
    });

    it('should re-fetch after TTL expires', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve(coinGeckoResponse('bitcoin', 98000)),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve(coinGeckoResponse('bitcoin', 99000)),
        });

      await getPrice('bitcoin');

      // Advance time past cache TTL (60s)
      vi.useFakeTimers();
      vi.advanceTimersByTime(61_000);

      // Need to re-stub fetch after fake timers
      vi.stubGlobal('fetch', fetchSpy);
      const result = await getPrice('bitcoin');

      vi.useRealTimers();

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result.price).toBe(99000);
    });

    it('should cache per coin independently', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve(coinGeckoResponse('bitcoin', 98000)),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve(coinGeckoResponse('ethereum', 3500)),
        });

      const btc = await getPrice('bitcoin');
      const eth = await getPrice('ethereum');

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(btc.price).toBe(98000);
      expect(eth.price).toBe(3500);
    });
  });

  // ── CoinGecko response parsing ──

  describe('response parsing', () => {
    it('should correctly parse a valid CoinGecko response', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve(coinGeckoResponse('bitcoin', 98234.56)),
      });

      const data = await getPrice('bitcoin');

      expect(data.coinId).toBe('bitcoin');
      expect(data.price).toBe(98234.56);
      expect(data.currency).toBe('usd');
      expect(data.source).toBe('coingecko');
      expect(typeof data.timestamp).toBe('number');
    });

    it('should throw NETWORK_ERROR for malformed response (missing price)', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ bitcoin: {} }),
      });

      try {
        await getPrice('bitcoin');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AzethError);
        expect((err as AzethError).code).toBe('NETWORK_ERROR');
      }
    });
  });

  // ── Error handling ──

  describe('error handling', () => {
    it('should throw NETWORK_ERROR on fetch timeout', async () => {
      const timeoutError = new Error('The operation was aborted');
      timeoutError.name = 'TimeoutError';
      fetchSpy.mockRejectedValueOnce(timeoutError);

      try {
        await getPrice('bitcoin');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AzethError);
        expect((err as AzethError).code).toBe('NETWORK_ERROR');
      }
    });

    it('should throw NETWORK_ERROR with retryAfterSeconds on 429', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '30' }),
      });

      try {
        await getPrice('bitcoin');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AzethError);
        const azethErr = err as AzethError;
        expect(azethErr.code).toBe('NETWORK_ERROR');
        expect(azethErr.details?.retryAfterSeconds).toBe(30);
      }
    });
  });

  // ── Stale-on-error ──

  describe('stale-on-error', () => {
    it('should return stale cached data when fetch fails', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve(coinGeckoResponse('bitcoin', 97000)),
      });

      // Prime the cache
      await getPrice('bitcoin');

      // Expire the cache
      vi.useFakeTimers();
      vi.advanceTimersByTime(61_000);

      // Make fetch fail
      fetchSpy.mockRejectedValueOnce(new Error('Network error'));
      vi.stubGlobal('fetch', fetchSpy);

      const result = await getPrice('bitcoin');
      vi.useRealTimers();

      expect(result.price).toBe(97000);
    });

    it('should throw when fetch fails and no cache exists', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Network error'));

      await expect(getPrice('bitcoin')).rejects.toThrow();
    });
  });

  // ── Force refresh ──

  describe('getFreshPrice', () => {
    it('should bypass cache', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve(coinGeckoResponse('bitcoin', 97000)),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve(coinGeckoResponse('bitcoin', 98000)),
        });

      await getPrice('bitcoin'); // Fills cache
      const fresh = await getFreshPrice('bitcoin');

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fresh.price).toBe(98000);
    });

    it('should rate-limit force refresh to 1 per coin per 10s', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve(coinGeckoResponse('bitcoin', 97000)),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve(coinGeckoResponse('bitcoin', 98000)),
        });

      // First force refresh should fetch
      await getFreshPrice('bitcoin');
      // Second force refresh within 10s should use cache (not re-fetch)
      const result = await getFreshPrice('bitcoin');

      // Only 2 calls: first getPrice would have been a miss, second was the force refresh
      // The third getFreshPrice falls back to getPrice which returns cache
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result.price).toBe(97000);
    });
  });

  // ── clearPriceCache ──

  describe('clearPriceCache', () => {
    it('should reset all cached state', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve(coinGeckoResponse('bitcoin', 97000)),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve(coinGeckoResponse('bitcoin', 98000)),
        });

      await getPrice('bitcoin');
      clearPriceCache();
      const result = await getPrice('bitcoin');

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result.price).toBe(98000);
    });
  });
});
