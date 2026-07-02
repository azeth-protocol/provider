import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { AzethError, TOKENS } from '@azeth/common';
import type { PublicClient, Chain, Transport } from 'viem';

// Mock viem's createPublicClient (used by preSettledPaymentMiddleware) — no RPC in tests
const mockGetTransactionReceipt = vi.fn();
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({ getTransactionReceipt: mockGetTransactionReceipt })),
  };
});

import { createPricingRoutes } from '../../src/examples/pricing-routes.js';
import { isSupportedCoin, getPrice, getFreshPrice, clearPriceCache } from '../../src/examples/price-feed.js';
import type { ProviderEnv } from '../../src/middleware/pre-settled.js';
import { AzethSIWxStorage } from '../../src/storage.js';
import { ACCESS_GRANT_HEADER } from '../../src/middleware/access-grant.js';
import type { x402HTTPResourceServer } from '../../src/stack.js';

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

  // ── Storage wiring (N5 recordPayment + F4 access-grant header) ──

  describe('storage wiring', () => {
    const PAY_TO = '0x2222222222222222222222222222222222222222';
    const USDC = TOKENS['baseSepolia'].USDC.toLowerCase();
    const SMART_ACCOUNT = '0x1111111111111111111111111111111111111111' as `0x${string}`;
    const TRANSFER_SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const mockPublicClient = {} as PublicClient<Transport, Chain>;

    let txCounter = 0;
    const nextTxHash = (): string => {
      txCounter += 1;
      return `0x${txCounter.toString(16).padStart(64, 'c')}`;
    };

    const pad32 = (addr: string): string => `0x${'0'.repeat(24)}${addr.slice(2).toLowerCase()}`;

    const validReceipt = () => ({
      status: 'success',
      logs: [
        {
          address: USDC,
          topics: [TRANSFER_SIG, pad32(SMART_ACCOUNT), pad32(PAY_TO)],
          data: `0x${(10_000n).toString(16).padStart(64, '0')}`,
        },
      ],
    });

    const siwxHeaderFor = (address: string): string =>
      Buffer.from(
        JSON.stringify({
          domain: 'localhost',
          address,
          uri: 'http://localhost/api/v1/pricing/bitcoin',
          version: '1',
          chainId: 'eip155:84532',
          type: 'eip191',
          nonce: `nonce-${txCounter}`,
          issuedAt: new Date().toISOString(),
          signature: '0xsig',
        }),
      ).toString('base64');

    /** Fake x402HTTPResourceServer with the exact surface paymentMiddlewareFromHTTPServer
     *  uses, mimicking the real SIWx request-hook decision: SIWx header → storage.hasPaid
     *  → grant as 'no-payment-required' (zero headers), otherwise a 402 payment-error. */
    const createFakeHttpServer = (storage: AzethSIWxStorage): x402HTTPResourceServer =>
      ({
        routes: {},
        server: { hasExtension: () => true },
        initialize: async () => undefined,
        requiresPayment: () => true,
        processHTTPRequest: async (context: {
          adapter: { getHeader(name: string): string | undefined };
          path: string;
        }) => {
          const siwx = context.adapter.getHeader('sign-in-with-x');
          if (siwx) {
            const payload = JSON.parse(Buffer.from(siwx, 'base64').toString('utf8')) as { address: string };
            if (await storage.hasPaid(context.path, payload.address)) {
              return { type: 'no-payment-required' };
            }
          }
          return {
            type: 'payment-error',
            response: { status: 402, headers: {}, body: { error: 'payment required' }, isHtml: false },
          };
        },
      }) as unknown as x402HTTPResourceServer;

    const savedEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of ['X402_PAY_TO', 'AZETH_CHAIN', 'X402_PRICE_FEED_PRICE']) {
        savedEnv[key] = process.env[key];
      }
      process.env['X402_PAY_TO'] = PAY_TO;
      process.env['AZETH_CHAIN'] = 'baseSepolia';
      delete process.env['X402_PRICE_FEED_PRICE'];
      mockGetTransactionReceipt.mockReset();
      // Price-feed responses for the business handler
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ bitcoin: { usd: 98000 } }),
      });
    });

    afterEach(() => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('with storage → both wirings active: pre-settled pay recorded, then SIWx-only access with X-Access-Grant: session', async () => {
      const storage = new AzethSIWxStorage({ publicClient: mockPublicClient, servicePayee: PAY_TO as `0x${string}` });
      const recordSpy = vi.spyOn(storage, 'recordPayment');
      const app = new Hono<ProviderEnv>();
      app.route('/api/v1/pricing', createPricingRoutes(createFakeHttpServer(storage), storage));

      // Request 1: pre-settled payment (X-Payment-Tx) — fresh settlement, no grant header
      mockGetTransactionReceipt.mockResolvedValueOnce(validReceipt());
      const first = await app.request('/api/v1/pricing/bitcoin', {
        headers: { 'X-Payment-Tx': nextTxHash() },
      });

      expect(first.status).toBe(200);
      expect(first.headers.get(ACCESS_GRANT_HEADER)).toBeNull();
      // N5 wiring: the verified on-chain payer was recorded into the SIWx storage
      expect(recordSpy).toHaveBeenCalledWith('/api/v1/pricing/bitcoin', SMART_ACCOUNT);

      // Request 2: SIWx-only — granted from the recorded payment, labeled session
      const second = await app.request('/api/v1/pricing/bitcoin', {
        headers: { 'sign-in-with-x': siwxHeaderFor(SMART_ACCOUNT) },
      });

      expect(second.status).toBe(200);
      expect(second.headers.get(ACCESS_GRANT_HEADER)).toBe('session');
      const body = (await second.json()) as { data: { coinId: string } };
      expect(body.data.coinId).toBe('bitcoin');
    });

    it('without storage (public API unchanged) → no header, no record, no crash', async () => {
      // The fake x402 layer still consults a storage — but createPricingRoutes never sees it,
      // so neither the recordPayment wiring nor the header middleware is registered.
      const storage = new AzethSIWxStorage({ publicClient: mockPublicClient, servicePayee: PAY_TO as `0x${string}` });
      const recordSpy = vi.spyOn(storage, 'recordPayment');
      const app = new Hono<ProviderEnv>();
      app.route('/api/v1/pricing', createPricingRoutes(createFakeHttpServer(storage)));

      // Pre-settled payment succeeds exactly as before
      mockGetTransactionReceipt.mockResolvedValueOnce(validReceipt());
      const first = await app.request('/api/v1/pricing/bitcoin', {
        headers: { 'X-Payment-Tx': nextTxHash() },
      });

      expect(first.status).toBe(200);
      expect(first.headers.get(ACCESS_GRANT_HEADER)).toBeNull();
      expect(recordSpy).not.toHaveBeenCalled();

      // SIWx-only follow-up is NOT granted (pre-storage-wiring behavior preserved)
      const second = await app.request('/api/v1/pricing/bitcoin', {
        headers: { 'sign-in-with-x': siwxHeaderFor(SMART_ACCOUNT) },
      });

      expect(second.status).toBe(402);
      expect(second.headers.get(ACCESS_GRANT_HEADER)).toBeNull();
    });

    it('503 (no facilitator) path never emits the header even with storage', async () => {
      const storage = new AzethSIWxStorage({ publicClient: mockPublicClient, servicePayee: PAY_TO as `0x${string}` });
      const app = new Hono<ProviderEnv>();
      app.route('/api/v1/pricing', createPricingRoutes(null, storage));

      const res = await app.request('/api/v1/pricing/bitcoin', {
        headers: { 'sign-in-with-x': siwxHeaderFor(SMART_ACCOUNT) },
      });

      expect(res.status).toBe(503);
      expect(res.headers.get(ACCESS_GRANT_HEADER)).toBeNull();
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
