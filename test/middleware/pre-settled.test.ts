import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock viem's createPublicClient so no RPC is ever hit — everything else stays real
// (parseAbiItem is used at module load by pre-settled.ts).
const mockGetTransactionReceipt = vi.fn();
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({ getTransactionReceipt: mockGetTransactionReceipt })),
  };
});

import { preSettledPaymentMiddleware, type ProviderEnv } from '../../src/middleware/pre-settled.js';

const TRANSFER_SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const PAY_TO = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e' as `0x${string}`;
const SMART_ACCOUNT = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const PRICE = 10_000n;

/** Module-level usedTxHashes persists across tests — give every test a unique hash */
let txCounter = 0;
function nextTxHash(): `0x${string}` {
  txCounter += 1;
  return `0x${txCounter.toString(16).padStart(64, 'a')}` as `0x${string}`;
}

function pad32(addr: string): `0x${string}` {
  return `0x${'0'.repeat(24)}${addr.slice(2).toLowerCase()}` as `0x${string}`;
}

function transferLog(opts?: { from?: string; to?: string; token?: string; value?: bigint }) {
  const value = opts?.value ?? PRICE;
  return {
    address: opts?.token ?? USDC,
    topics: [TRANSFER_SIG, pad32(opts?.from ?? SMART_ACCOUNT), pad32(opts?.to ?? PAY_TO)],
    data: `0x${value.toString(16).padStart(64, '0')}`,
  };
}

function successReceipt(logs: ReturnType<typeof transferLog>[]) {
  return { status: 'success', logs };
}

/** Test app: the handler reports whether the pre-settled path verified the payment */
function makeApp(recordPayment?: (resource: string, payer: `0x${string}`) => void) {
  const app = new Hono<ProviderEnv>();
  app.use(
    '/pricing/:coinId',
    preSettledPaymentMiddleware({
      payTo: PAY_TO,
      usdcAddress: USDC,
      priceAtomicAmount: PRICE,
      ...(recordPayment ? { recordPayment } : {}),
    }),
  );
  app.get('/pricing/:coinId', (c) =>
    c.json({
      preSettled: Boolean((c as unknown as Record<string, unknown>)['preSettledVerified']),
      paymentFrom: c.get('paymentFrom') ?? null,
    }),
  );
  return app;
}

describe('preSettledPaymentMiddleware — recordPayment (N5)', () => {
  beforeEach(() => {
    mockGetTransactionReceipt.mockReset();
  });

  it('valid receipt → recordPayment(c.req.path, logFrom) called with the on-chain from, not a client-supplied value', async () => {
    const recordPayment = vi.fn();
    const app = makeApp(recordPayment);
    mockGetTransactionReceipt.mockResolvedValueOnce(successReceipt([transferLog()]));

    const res = await app.request('/pricing/bitcoin', {
      headers: { 'X-Payment-Tx': nextTxHash() },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { preSettled: boolean; paymentFrom: string | null };
    expect(body.preSettled).toBe(true);
    // Payer comes from the on-chain Transfer log topics — the smart account address
    expect(recordPayment).toHaveBeenCalledOnce();
    expect(recordPayment).toHaveBeenCalledWith('/pricing/bitcoin', SMART_ACCOUNT);
  });

  it('resource key is the pathname (query string excluded)', async () => {
    const recordPayment = vi.fn();
    const app = makeApp(recordPayment);
    mockGetTransactionReceipt.mockResolvedValueOnce(successReceipt([transferLog()]));

    const res = await app.request('/pricing/bitcoin?fresh=true', {
      headers: { 'X-Payment-Tx': nextTxHash() },
    });

    expect(res.status).toBe(200);
    expect(recordPayment).toHaveBeenCalledWith('/pricing/bitcoin', SMART_ACCOUNT);
  });

  it("no recordPayment configured → today's behavior (verified, no crash)", async () => {
    const app = makeApp();
    mockGetTransactionReceipt.mockResolvedValueOnce(successReceipt([transferLog()]));

    const res = await app.request('/pricing/bitcoin', {
      headers: { 'X-Payment-Tx': nextTxHash() },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { preSettled: boolean };
    expect(body.preSettled).toBe(true);
  });

  it('replayed txHash → falls through to x402, NOT recorded twice', async () => {
    const recordPayment = vi.fn();
    const app = makeApp(recordPayment);
    const txHash = nextTxHash();
    mockGetTransactionReceipt.mockResolvedValue(successReceipt([transferLog()]));

    const first = await app.request('/pricing/bitcoin', { headers: { 'X-Payment-Tx': txHash } });
    expect(((await first.json()) as { preSettled: boolean }).preSettled).toBe(true);

    // Same hash again — consumed, falls through without verifying or recording
    const second = await app.request('/pricing/bitcoin', { headers: { 'X-Payment-Tx': txHash } });
    expect(((await second.json()) as { preSettled: boolean }).preSettled).toBe(false);

    expect(recordPayment).toHaveBeenCalledTimes(1);
  });

  it('failed (reverted) receipt → no record, falls through', async () => {
    const recordPayment = vi.fn();
    const app = makeApp(recordPayment);
    mockGetTransactionReceipt.mockResolvedValueOnce({ status: 'reverted', logs: [transferLog()] });

    const res = await app.request('/pricing/bitcoin', {
      headers: { 'X-Payment-Tx': nextTxHash() },
    });

    expect(((await res.json()) as { preSettled: boolean }).preSettled).toBe(false);
    expect(recordPayment).not.toHaveBeenCalled();
  });

  it('invalid receipt (no matching Transfer to payTo) → no record, falls through', async () => {
    const recordPayment = vi.fn();
    const app = makeApp(recordPayment);
    mockGetTransactionReceipt.mockResolvedValueOnce(
      successReceipt([transferLog({ to: '0x9999999999999999999999999999999999999999' })]),
    );

    const res = await app.request('/pricing/bitcoin', {
      headers: { 'X-Payment-Tx': nextTxHash() },
    });

    expect(((await res.json()) as { preSettled: boolean }).preSettled).toBe(false);
    expect(recordPayment).not.toHaveBeenCalled();
  });

  it('underpaid Transfer (value below price) → no record, falls through', async () => {
    const recordPayment = vi.fn();
    const app = makeApp(recordPayment);
    mockGetTransactionReceipt.mockResolvedValueOnce(
      successReceipt([transferLog({ value: PRICE - 1n })]),
    );

    const res = await app.request('/pricing/bitcoin', {
      headers: { 'X-Payment-Tx': nextTxHash() },
    });

    expect(((await res.json()) as { preSettled: boolean }).preSettled).toBe(false);
    expect(recordPayment).not.toHaveBeenCalled();
  });

  it('recordPayment throwing → request still succeeds with payment verified', async () => {
    const recordPayment = vi.fn(() => {
      throw new Error('storage exploded');
    });
    const app = makeApp(recordPayment);
    mockGetTransactionReceipt.mockResolvedValueOnce(successReceipt([transferLog()]));

    const res = await app.request('/pricing/bitcoin', {
      headers: { 'X-Payment-Tx': nextTxHash() },
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { preSettled: boolean }).preSettled).toBe(true);
    expect(recordPayment).toHaveBeenCalledOnce();
  });
});
