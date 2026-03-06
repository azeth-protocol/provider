import { Hono } from 'hono';
import { AzethError, TOKENS, type SupportedChainName, type CatalogEntry } from '@azeth/common';
import { paymentMiddlewareFromHTTPServer } from '@x402/hono';
import type { x402HTTPResourceServer } from '@x402/core/server';
import type { ProviderEnv } from '../middleware/pre-settled.js';
import { isSupportedCoin, getPrice, getFreshPrice } from './price-feed.js';
import { preSettledPaymentMiddleware } from '../middleware/pre-settled.js';

/** Supported coin IDs for the catalog — single source of truth matching price-feed.ts */
const CATALOG_COINS = [
  'bitcoin', 'ethereum', 'solana', 'usd-coin', 'chainlink',
  'aave', 'uniswap', 'maker', 'compound-governance-token',
] as const;

/** Build the off-chain service catalog for the pricing API */
function buildPricingCatalog(): CatalogEntry[] {
  const priceStr = process.env['X402_PRICE_FEED_PRICE'] ?? '$0.01';
  return [
    {
      name: 'Get Price',
      path: '/{coinId}',
      method: 'GET',
      description: 'Get real-time price data for a cryptocurrency. Returns price in USD, 24h change, market cap, and volume.',
      pricing: `${priceStr}/request`,
      params: { coinId: CATALOG_COINS.join(', ') },
      paid: true,
      accepts: [
        {
          network: 'eip155:84532',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`,
          symbol: 'USDC',
        },
      ],
    },
    {
      name: 'Get Fresh Price',
      path: '/{coinId}?fresh=true',
      method: 'GET',
      description: 'Force-refresh price data bypassing cache. Same as Get Price but fetches live data from CoinGecko.',
      pricing: `${priceStr}/request`,
      params: { coinId: CATALOG_COINS.join(', ') },
      paid: true,
    },
  ];
}

/** Create the x402-gated pricing routes.
 *
 *  Uses @x402/hono middleware for V2 protocol support including:
 *  - PAYMENT-SIGNATURE / PAYMENT-RESPONSE headers (v2)
 *  - SIWx wallet-based sessions (pay once, then access via wallet sig)
 *  - Payment agreement extension (subscription terms in 402 response)
 *  - Pre-settled smart account payments (X-Payment-Tx header bypass)
 *
 *  The root GET / serves the off-chain catalog (free, no payment required).
 *  When httpServer is null, paid routes return 503 (graceful degradation).
 */
export function createPricingRoutes(httpServer: x402HTTPResourceServer | null): Hono<ProviderEnv> {
  const app = new Hono<ProviderEnv>();

  // ── Free catalog endpoint ──
  // Serves the off-chain service catalog — the "menu card" describing available
  // offerings, pricing, and accepted payment methods. No payment or auth required.
  app.get('/', (c) => {
    return c.json({
      data: {
        name: 'Azeth Price Feed',
        description: 'x402-gated cryptocurrency price data API powered by Azeth',
        catalog: buildPricingCatalog(),
      },
    });
  });

  if (!httpServer) {
    app.get('/:coinId', (c) => {
      return c.json(
        {
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Price feed requires x402 facilitator configuration',
          },
        },
        503,
      );
    });
    return app;
  }

  // Pre-settled payment verification — checks X-Payment-Tx header for smart account payments.
  // If a valid on-chain Transfer is found, sets paymentTxHash/paymentFrom/paymentAmount context
  // and skips the x402 facilitator settlement (payment already happened via UserOp).
  const payTo = (process.env['X402_PAY_TO'] ?? '') as `0x${string}`;
  const chainName = (process.env['AZETH_CHAIN'] ?? 'baseSepolia') as SupportedChainName;
  // Use chain-aware USDC address from TOKENS constants (not env var, which may be for a different chain)
  const usdcAddress = TOKENS[chainName].USDC as `0x${string}`;
  const priceStr = process.env['X402_PRICE_FEED_PRICE'] ?? '$0.01';
  // Parse price string like "$0.01" to atomic USDC (6 decimals)
  const priceNum = parseFloat(priceStr.replace('$', ''));
  const priceAtomicAmount = BigInt(Math.round(priceNum * 1e6));

  // Payment middleware scoped to /:coinId — catalog root (/) is free.
  if (payTo && usdcAddress) {
    app.use('/:coinId', preSettledPaymentMiddleware({
      payTo,
      usdcAddress,
      priceAtomicAmount,
      rpcUrl: process.env['AZETH_RPC_URL'] ?? process.env['BASE_RPC_URL'],
      chainName,
    }));
  }

  // x402 V2 middleware — handles 402, verify, settle, SIWx, extensions.
  // Scoped to /:coinId only. Skipped when pre-settled payment was verified.
  app.use('/:coinId', async (c, next) => {
    if ((c as unknown as Record<string, unknown>)['preSettledVerified']) {
      return next();
    }
    return paymentMiddlewareFromHTTPServer(httpServer)(c, next);
  });

  // Price data handler — pure business logic, no payment context needed.
  // Payment info (amount, settlement tx) is in response headers via standard x402 protocol:
  // - PAYMENT-RESPONSE header contains { success, transaction, network }
  app.get('/:coinId', async (c) => {
    const coinId = c.req.param('coinId');

    if (!isSupportedCoin(coinId)) {
      throw new AzethError('Unsupported coin', 'INVALID_INPUT', {
        coinId,
        supported: [...CATALOG_COINS],
      });
    }

    const fresh = c.req.query('fresh') === 'true';
    const data = fresh ? await getFreshPrice(coinId) : await getPrice(coinId);

    return c.json({ data });
  });

  return app;
}
