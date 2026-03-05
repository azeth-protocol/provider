import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { AzethError } from '@azeth/common';
import { createPricingRoutes } from '../../src/examples/pricing-routes.js';
import { isSupportedCoin, getPrice, getFreshPrice, clearPriceCache } from '../../src/examples/price-feed.js';
import type { ProviderEnv } from '../../src/middleware/pre-settled.js';

/** Build a test app that simulates already-validated payment.
 *  Bypasses x402 middleware entirely — directly tests the handler logic. */
function createHandlerTestApp() {
  const app = new Hono<ProviderEnv>();
  app.onError((err, c) => {
    if (err instanceof AzethError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details ?? null } }, 400);
    }
    return c.json({ error: { code: 'INTERNAL_ERROR', message: err.message } }, 500);
  });

  // Simulate paid request (payment info is in x402 protocol headers now,
  // not in Hono context — but we can still test handler business logic)
  app.use('/api/v1/pricing/:coinId', async (_c, next) => {
    await next();
  });

  // Mount handler directly (same logic as createPricingRoutes handler)
  app.get('/api/v1/pricing/:coinId', async (c) => {
    const coinId = c.req.param('coinId');

    if (!isSupportedCoin(coinId)) {
      throw new AzethError('Unsupported coin', 'INVALID_INPUT', {
        coinId,
        supported: [
          'bitcoin', 'ethereum', 'solana', 'usd-coin', 'chainlink',
          'aave', 'uniswap', 'maker', 'compound-governance-token',
        ],
      });
    }

    const fresh = c.req.query('fresh') === 'true';
    const data = fresh ? await getFreshPrice(coinId) : await getPrice(coinId);

    return c.json({ data });
  });

  return app;
}

describe('Pricing Routes', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearPriceCache();
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── No Facilitator ──

  describe('when facilitator config is null', () => {
    it('should return 503 for any coin', async () => {
      const app = new Hono<ProviderEnv>();
      app.route('/api/v1/pricing', createPricingRoutes(null));

      const res = await app.request('/api/v1/pricing/bitcoin');

      expect(res.status).toBe(503);
      const body = await res.json() as { error: { message: string } };
      expect(body.error.message).toContain('x402 facilitator configuration');
    });
  });

  // ── Valid Payment (handler tests) ──

  describe('when payment is valid', () => {
    it('should return 200 with price data', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ bitcoin: { usd: 98234.56 } }),
      });

      const app = createHandlerTestApp();
      const res = await app.request('/api/v1/pricing/bitcoin');

      expect(res.status).toBe(200);
      const body = await res.json() as {
        data: {
          coinId: string;
          price: number;
          currency: string;
          source: string;
        };
      };

      expect(body.data.coinId).toBe('bitcoin');
      expect(body.data.price).toBe(98234.56);
      expect(body.data.currency).toBe('usd');
      expect(body.data.source).toBe('coingecko');
    });

    it('should support fresh=true query param', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ bitcoin: { usd: 97000 } }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: () => Promise.resolve({ bitcoin: { usd: 98000 } }),
        });

      const app = createHandlerTestApp();

      // First request fills cache
      await app.request('/api/v1/pricing/bitcoin');

      // Second request with fresh=true should re-fetch
      const res = await app.request('/api/v1/pricing/bitcoin?fresh=true');

      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ── Invalid Coin ID ──

  describe('input validation', () => {
    it('should return 400 for unsupported coin', async () => {
      const app = createHandlerTestApp();
      const res = await app.request('/api/v1/pricing/dogecoin');

      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_INPUT');
    });
  });

  // ── Response format ──

  describe('response format', () => {
    it('should contain all expected fields in response', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ ethereum: { usd: 3500.42 } }),
      });

      const app = createHandlerTestApp();
      const res = await app.request('/api/v1/pricing/ethereum');

      expect(res.status).toBe(200);
      const body = await res.json() as { data: Record<string, unknown> };
      expect(body.data).toHaveProperty('coinId');
      expect(body.data).toHaveProperty('price');
      expect(body.data).toHaveProperty('currency');
      expect(body.data).toHaveProperty('timestamp');
      expect(body.data).toHaveProperty('source');
    });
  });
});
