import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { PublicClient, Chain, Transport } from 'viem';

vi.mock('../../src/agreement-cache.js', () => ({
  findActiveAgreementForPayee: vi.fn(),
  clearAgreementCache: vi.fn(),
  setAgreementCacheTtl: vi.fn(),
}));

// Mock viem's createPublicClient (used by preSettledPaymentMiddleware) — no RPC in tests
const mockGetTransactionReceipt = vi.fn();
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({ getTransactionReceipt: mockGetTransactionReceipt })),
  };
});

import { findActiveAgreementForPayee } from '../../src/agreement-cache.js';
import { AzethSIWxStorage } from '../../src/storage.js';
import { preSettledPaymentMiddleware, type ProviderEnv } from '../../src/middleware/pre-settled.js';
import { accessGrantHeaderMiddleware, ACCESS_GRANT_HEADER } from '../../src/middleware/access-grant.js';

const mockFindAgreement = vi.mocked(findActiveAgreementForPayee);
const mockPublicClient = {} as PublicClient<Transport, Chain>;

const SERVICE_PAYEE = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const MODULE_ADDRESS = '0x9999999999999999999999999999999999999999' as `0x${string}`;
const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`;
const USER_ADDRESS = '0x1111111111111111111111111111111111111111';
const RESOURCE = '/api/v1/pricing/bitcoin';

const VALID_AGREEMENT = {
  id: 0n,
  payee: SERVICE_PAYEE,
  token: TOKEN,
  amount: 5000n,
  interval: 86400n,
  endTime: 0n,
  lastExecuted: 0n,
  maxExecutions: 0n,
  executionCount: 0n,
  totalCap: 0n,
  totalPaid: 0n,
  active: true,
};

function createStorage(opts?: { minAgreementAmount?: bigint }) {
  return new AzethSIWxStorage({
    publicClient: mockPublicClient,
    servicePayee: SERVICE_PAYEE,
    serviceToken: TOKEN,
    moduleAddress: MODULE_ADDRESS,
    minAgreementAmount: opts?.minAgreementAmount ?? 1000n,
  });
}

describe('x402 Agreement-Based Access Flow (Flow 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. Valid active + executable agreement grants access
  it('grants access when a valid active agreement exists', async () => {
    const storage = createStorage();

    mockFindAgreement.mockResolvedValueOnce(VALID_AGREEMENT);

    const result = await storage.hasPaid(RESOURCE, USER_ADDRESS);

    expect(result).toBe(true);
    expect(mockFindAgreement).toHaveBeenCalledWith(
      mockPublicClient,
      MODULE_ADDRESS,
      USER_ADDRESS,
      SERVICE_PAYEE,
      TOKEN,
      1000n,
    );
  });

  // 2. Expired agreement denies access (findActiveAgreementForPayee filters it)
  it('denies access when agreement has expired (returns null from cache)', async () => {
    const storage = createStorage();

    // The agreementCache filters expired agreements — returns null
    mockFindAgreement.mockResolvedValueOnce(null);

    const result = await storage.hasPaid(RESOURCE, USER_ADDRESS);

    expect(result).toBe(false);
  });

  // 3. Non-executable agreement denies access
  it('denies access when agreement is not executable (insufficient balance)', async () => {
    const storage = createStorage();

    // The agreementCache checks executable flag — returns null for non-executable
    mockFindAgreement.mockResolvedValueOnce(null);

    const result = await storage.hasPaid(RESOURCE, USER_ADDRESS);

    expect(result).toBe(false);
  });

  // 4. Wrong payee — no agreement found
  it('denies access when no agreement exists for this payee', async () => {
    const storage = createStorage();

    // No agreement matching this payee
    mockFindAgreement.mockResolvedValueOnce(null);

    const result = await storage.hasPaid(RESOURCE, USER_ADDRESS);

    expect(result).toBe(false);
    // Verify it was called with the correct payee
    expect(mockFindAgreement).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      USER_ADDRESS,
      SERVICE_PAYEE,
      TOKEN,
      1000n,
    );
  });

  // 5. Agreement amount below server's minimum
  it('denies access when agreement amount is below minimum', async () => {
    const storage = createStorage({ minAgreementAmount: 10_000n });

    // minAmount=10000 filters out agreements with amount < 10000
    mockFindAgreement.mockResolvedValueOnce(null);

    const result = await storage.hasPaid(RESOURCE, USER_ADDRESS);

    expect(result).toBe(false);
    expect(mockFindAgreement).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      10_000n,
    );
  });

  // 6. Keeper is notified when agreement grants access
  it('notifies keeper to track agreement when access is granted', async () => {
    const storage = createStorage();
    const mockKeeper = { trackAgreement: vi.fn() };
    storage.setKeeper(mockKeeper as any);

    mockFindAgreement.mockResolvedValueOnce({ ...VALID_AGREEMENT, id: 42n });

    const result = await storage.hasPaid(RESOURCE, USER_ADDRESS);

    expect(result).toBe(true);
    expect(mockKeeper.trackAgreement).toHaveBeenCalledWith(
      USER_ADDRESS,
      42n,
    );
  });

  // 7. Keeper is NOT notified when agreement check fails
  it('does not notify keeper when no agreement is found', async () => {
    const storage = createStorage();
    const mockKeeper = { trackAgreement: vi.fn() };
    storage.setKeeper(mockKeeper as any);

    mockFindAgreement.mockResolvedValueOnce(null);

    const result = await storage.hasPaid(RESOURCE, USER_ADDRESS);

    expect(result).toBe(false);
    expect(mockKeeper.trackAgreement).not.toHaveBeenCalled();
  });

  // 8. Settlement-paid user bypasses agreement check entirely
  it('grants access via settlement record without checking agreements', async () => {
    const storage = createStorage();

    // Record a direct x402 settlement payment
    storage.recordPayment(RESOURCE, USER_ADDRESS);

    const result = await storage.hasPaid(RESOURCE, USER_ADDRESS);

    expect(result).toBe(true);
    // Settlement takes priority — no agreement lookup needed
    expect(mockFindAgreement).not.toHaveBeenCalled();
  });

  // 9. Agreement check error is non-fatal — falls through to 402
  it('returns false when agreement check throws (RPC error)', async () => {
    const storage = createStorage();

    mockFindAgreement.mockRejectedValueOnce(new Error('RPC timeout'));

    const result = await storage.hasPaid(RESOURCE, USER_ADDRESS);

    expect(result).toBe(false);
  });

  // 10. Re-verification on each call (no permanent agreement caching in storage)
  it('re-verifies agreement on each hasPaid call', async () => {
    const storage = createStorage();

    // First call: agreement found
    mockFindAgreement.mockResolvedValueOnce(VALID_AGREEMENT);
    expect(await storage.hasPaid(RESOURCE, USER_ADDRESS)).toBe(true);

    // Second call: agreement no longer valid (e.g., balance drained)
    mockFindAgreement.mockResolvedValueOnce(null);
    expect(await storage.hasPaid(RESOURCE, USER_ADDRESS)).toBe(false);

    // Each call triggers a fresh check via findActiveAgreementForPayee
    expect(mockFindAgreement).toHaveBeenCalledTimes(2);
  });

  // 11. No module address configured — skips agreement check entirely
  it('skips agreement check when moduleAddress is not configured', async () => {
    const storage = new AzethSIWxStorage({
      publicClient: mockPublicClient,
      servicePayee: SERVICE_PAYEE,
    });

    const result = await storage.hasPaid(RESOURCE, USER_ADDRESS);

    expect(result).toBe(false);
    expect(mockFindAgreement).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-level wiring: pre-settled recording (N5) + access-grant header (F4)
// ─────────────────────────────────────────────────────────────────────────────

const TRANSFER_SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const USDC = TOKEN.toLowerCase() as `0x${string}`;
/** On-chain Transfer `from` — the smart account, exactly the address SIWx presents */
const SMART_ACCOUNT = '0x1111111111111111111111111111111111111111' as `0x${string}`;
/** Checksum-style casing as a wallet would present it in the SIWx payload */
const SMART_ACCOUNT_CHECKSUMMED = '0x1111111111111111111111111111111111111111';
const PRICE = 10_000n;
const HTTP_RESOURCE = '/api/v1/pricing/bitcoin';

let txCounter = 0;
function nextTxHash(): `0x${string}` {
  txCounter += 1;
  return `0x${txCounter.toString(16).padStart(64, 'b')}` as `0x${string}`;
}

function pad32(addr: string): `0x${string}` {
  return `0x${'0'.repeat(24)}${addr.slice(2).toLowerCase()}` as `0x${string}`;
}

function validReceipt(from: `0x${string}`) {
  return {
    status: 'success',
    logs: [
      {
        address: USDC,
        topics: [TRANSFER_SIG, pad32(from), pad32(SERVICE_PAYEE)],
        data: `0x${PRICE.toString(16).padStart(64, '0')}`,
      },
    ],
  };
}

function siwxHeaderFor(address: string): string {
  return Buffer.from(
    JSON.stringify({
      domain: 'localhost',
      address,
      uri: `http://localhost${HTTP_RESOURCE}`,
      version: '1',
      chainId: 'eip155:84532',
      type: 'eip191',
      nonce: `nonce-${txCounter}-${Math.random().toString(36).slice(2)}`,
      issuedAt: new Date().toISOString(),
      signature: '0xsig',
    }),
  ).toString('base64');
}

/** Build the same middleware composition createPricingRoutes uses, with the @x402
 *  layer simulated faithfully (mirrors paymentMiddlewareFromHTTPServer +
 *  createSIWxRequestHook + createSIWxSettleHook semantics):
 *  - preSettledVerified → skip the x402 layer entirely (same as the pricing-routes wrapper)
 *  - SIWx header → storage.hasPaid(path, address) → grant with ZERO payment headers
 *    (a grant response is byte-identical to a free one — that is why F4 needs the
 *    Hono post-middleware)
 *  - PAYMENT-SIGNATURE header → settle: count++, recordPayment (settle hook),
 *    PAYMENT-RESPONSE header on the response
 *  - otherwise → 402
 *  SIWx signature/nonce verification is @x402-internal and out of scope here. */
function buildPaidApp(storage: AzethSIWxStorage) {
  const app = new Hono<ProviderEnv>();
  const settlements: string[] = [];

  app.use(`/api/v1/pricing/:coinId`, accessGrantHeaderMiddleware(storage));
  app.use(
    `/api/v1/pricing/:coinId`,
    preSettledPaymentMiddleware({
      payTo: SERVICE_PAYEE,
      usdcAddress: USDC,
      priceAtomicAmount: PRICE,
      recordPayment: (r, a) => storage.recordPayment(r, a),
    }),
  );
  app.use(`/api/v1/pricing/:coinId`, async (c, next) => {
    if ((c as unknown as Record<string, unknown>)['preSettledVerified']) {
      return next();
    }
    const siwx = c.req.header('sign-in-with-x');
    if (siwx) {
      const payload = JSON.parse(Buffer.from(siwx, 'base64').toString('utf8')) as { address: string };
      if (await storage.hasPaid(c.req.path, payload.address)) {
        return next(); // grant — no payment headers
      }
    }
    const paymentSig = c.req.header('PAYMENT-SIGNATURE');
    if (paymentSig) {
      settlements.push(paymentSig);
      storage.recordPayment(c.req.path, paymentSig.slice(0, 42)); // settle hook records the payer
      await next();
      c.res.headers.set('PAYMENT-RESPONSE', 'encoded-settlement');
      return;
    }
    return c.json({ error: 'payment required' }, 402);
  });
  app.get(`/api/v1/pricing/:coinId`, (c) => c.json({ data: { coinId: c.req.param('coinId'), price: 1 } }));

  return { app, settlements };
}

describe('x402 repeat-pay flow (N5 regression + F4 header)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTransactionReceipt.mockReset();
  });

  // [REGRESSION N5] repeated pay must NOT re-settle on-chain
  it('repeat pay does not re-settle: pre-settled pay once, then SIWx-only access without settlement', async () => {
    const storage = new AzethSIWxStorage({
      publicClient: mockPublicClient,
      servicePayee: SERVICE_PAYEE,
    });
    const { app, settlements } = buildPaidApp(storage);

    // Request 1: pays via X-Payment-Tx (pre-settled smart account payment)
    mockGetTransactionReceipt.mockResolvedValueOnce(validReceipt(SMART_ACCOUNT));
    const first = await app.request(HTTP_RESOURCE, {
      headers: { 'X-Payment-Tx': nextTxHash(), 'sign-in-with-x': siwxHeaderFor(SMART_ACCOUNT_CHECKSUMMED) },
    });

    expect(first.status).toBe(200);
    // Fresh settlement (pre-settled) — no access-grant discriminator
    expect(first.headers.get(ACCESS_GRANT_HEADER)).toBeNull();
    expect(settlements).toHaveLength(0);

    // Request 2: SIWx only — same wallet, no payment headers at all
    const second = await app.request(HTTP_RESOURCE, {
      headers: { 'sign-in-with-x': siwxHeaderFor(SMART_ACCOUNT_CHECKSUMMED) },
    });

    expect(second.status).toBe(200);
    // NO settlement happened — the double-charge is gone
    expect(settlements).toHaveLength(0);
    expect(second.headers.get('PAYMENT-RESPONSE')).toBeNull();
    // Access was granted via the recorded prior payment → session
    expect(second.headers.get(ACCESS_GRANT_HEADER)).toBe('session');
    const body = (await second.json()) as { data: { coinId: string } };
    expect(body.data.coinId).toBe('bitcoin');
  });

  it('agreement-based grant carries X-Access-Grant: agreement', async () => {
    const storage = new AzethSIWxStorage({
      publicClient: mockPublicClient,
      servicePayee: SERVICE_PAYEE,
      serviceToken: TOKEN,
      moduleAddress: MODULE_ADDRESS,
    });
    const { app, settlements } = buildPaidApp(storage);

    // No prior payment — access comes from the on-chain agreement (tier-2)
    mockFindAgreement.mockResolvedValue(VALID_AGREEMENT);

    const res = await app.request(HTTP_RESOURCE, {
      headers: { 'sign-in-with-x': siwxHeaderFor(USER_ADDRESS) },
    });

    expect(res.status).toBe(200);
    expect(settlements).toHaveLength(0);
    expect(res.headers.get(ACCESS_GRANT_HEADER)).toBe('agreement');
  });

  it('fresh x402 settlement emits PAYMENT-RESPONSE and never X-Access-Grant', async () => {
    const storage = new AzethSIWxStorage({
      publicClient: mockPublicClient,
      servicePayee: SERVICE_PAYEE,
    });
    const { app, settlements } = buildPaidApp(storage);

    const res = await app.request(HTTP_RESOURCE, {
      headers: {
        'PAYMENT-SIGNATURE': `${USER_ADDRESS}-signed-payment`,
        'sign-in-with-x': siwxHeaderFor(USER_ADDRESS),
      },
    });

    expect(res.status).toBe(200);
    expect(settlements).toHaveLength(1);
    expect(res.headers.get('PAYMENT-RESPONSE')).toBe('encoded-settlement');
    expect(res.headers.get(ACCESS_GRANT_HEADER)).toBeNull();
  });

  it('no credentials at all → 402 without X-Access-Grant', async () => {
    const storage = new AzethSIWxStorage({
      publicClient: mockPublicClient,
      servicePayee: SERVICE_PAYEE,
    });
    const { app } = buildPaidApp(storage);

    const res = await app.request(HTTP_RESOURCE);

    expect(res.status).toBe(402);
    expect(res.headers.get(ACCESS_GRANT_HEADER)).toBeNull();
  });
});
