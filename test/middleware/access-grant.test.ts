import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { PublicClient, Chain, Transport } from 'viem';

vi.mock('../../src/agreement-cache.js', () => ({
  findActiveAgreementForPayee: vi.fn(),
}));

import { findActiveAgreementForPayee } from '../../src/agreement-cache.js';
import { AzethSIWxStorage } from '../../src/storage.js';
import { accessGrantHeaderMiddleware, ACCESS_GRANT_HEADER } from '../../src/middleware/access-grant.js';

const mockFindAgreement = vi.mocked(findActiveAgreementForPayee);
const mockPublicClient = {} as PublicClient<Transport, Chain>;

const SERVICE_PAYEE = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const MODULE_ADDRESS = '0x9999999999999999999999999999999999999999' as `0x${string}`;
const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`;
const USER_ADDRESS = '0x1111111111111111111111111111111111111111';
const RESOURCE = '/r/bitcoin';

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

/** Encode a structurally-valid SIWx header for an address (signature not verified here —
 *  the middleware only parses to extract the address for the grant-kind lookup). */
function siwxHeader(address: string): string {
  return Buffer.from(
    JSON.stringify({
      domain: 'localhost',
      address,
      uri: `http://localhost${RESOURCE}`,
      version: '1',
      chainId: 'eip155:84532',
      type: 'eip191',
      nonce: 'test-nonce-123',
      issuedAt: new Date().toISOString(),
      signature: '0xsig',
    }),
  ).toString('base64');
}

interface HandlerOpts {
  status?: 402;
  paymentResponse?: boolean;
  preSettled?: boolean;
}

/** App with the access-grant middleware wrapping a configurable inner stack */
function makeApp(storage: AzethSIWxStorage, opts?: HandlerOpts) {
  const app = new Hono();
  app.use('/r/:id', accessGrantHeaderMiddleware(storage));
  if (opts?.preSettled) {
    // Mirror the raw-context flag the pre-settled middleware sets
    app.use('/r/:id', async (c, next) => {
      (c as unknown as Record<string, unknown>)['preSettledVerified'] = true;
      await next();
    });
  }
  app.get('/r/:id', (c) => {
    if (opts?.paymentResponse) c.header('PAYMENT-RESPONSE', 'encoded-settlement');
    if (opts?.status === 402) return c.json({ error: 'payment required' }, 402);
    return c.json({ ok: true });
  });
  return app;
}

describe('accessGrantHeaderMiddleware (F4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits 'session' when the grant was satisfied by a payment record (tier-1)", async () => {
    const storage = new AzethSIWxStorage({ publicClient: mockPublicClient, servicePayee: SERVICE_PAYEE });
    storage.recordPayment(RESOURCE, USER_ADDRESS);
    expect(await storage.hasPaid(RESOURCE, USER_ADDRESS)).toBe(true); // grant happens inside the request in prod

    const app = makeApp(storage);
    const res = await app.request(RESOURCE, { headers: { 'sign-in-with-x': siwxHeader(USER_ADDRESS) } });

    expect(res.status).toBe(200);
    expect(res.headers.get(ACCESS_GRANT_HEADER)).toBe('session');
  });

  it("emits 'agreement' when the grant was satisfied by an on-chain agreement (tier-2)", async () => {
    const storage = new AzethSIWxStorage({
      publicClient: mockPublicClient,
      servicePayee: SERVICE_PAYEE,
      serviceToken: TOKEN,
      moduleAddress: MODULE_ADDRESS,
    });
    mockFindAgreement.mockResolvedValueOnce(VALID_AGREEMENT);
    expect(await storage.hasPaid(RESOURCE, USER_ADDRESS)).toBe(true);

    const app = makeApp(storage);
    const res = await app.request(RESOURCE, { headers: { 'sign-in-with-x': siwxHeader(USER_ADDRESS) } });

    expect(res.status).toBe(200);
    expect(res.headers.get(ACCESS_GRANT_HEADER)).toBe('agreement');
  });

  it("falls back to 'session' when no grant kind is known (e.g., auth-only routes)", async () => {
    const storage = new AzethSIWxStorage({ publicClient: mockPublicClient, servicePayee: SERVICE_PAYEE });

    const app = makeApp(storage);
    const res = await app.request(RESOURCE, { headers: { 'sign-in-with-x': siwxHeader(USER_ADDRESS) } });

    expect(res.status).toBe(200);
    expect(res.headers.get(ACCESS_GRANT_HEADER)).toBe('session');
  });

  it('looks up the grant kind by the SIWx address — checksummed address still matches', async () => {
    const storage = new AzethSIWxStorage({
      publicClient: mockPublicClient,
      servicePayee: SERVICE_PAYEE,
      serviceToken: TOKEN,
      moduleAddress: MODULE_ADDRESS,
    });
    const lowercase = '0xabcdef1234abcdef1234abcdef1234abcdef1234';
    mockFindAgreement.mockResolvedValueOnce(VALID_AGREEMENT);
    expect(await storage.hasPaid(RESOURCE, lowercase)).toBe(true);

    // SIWx payloads typically carry checksummed addresses; grant kinds are stored lowercase
    const mixedCase = '0xABCdef1234ABCdef1234ABCdef1234ABCdef1234';
    const app = makeApp(storage);
    const res = await app.request(RESOURCE, { headers: { 'sign-in-with-x': siwxHeader(mixedCase) } });

    expect(res.headers.get(ACCESS_GRANT_HEADER)).toBe('agreement');
  });

  it('no SIWx header → no header', async () => {
    const storage = new AzethSIWxStorage({ publicClient: mockPublicClient, servicePayee: SERVICE_PAYEE });
    storage.recordPayment(RESOURCE, USER_ADDRESS);
    await storage.hasPaid(RESOURCE, USER_ADDRESS);

    const app = makeApp(storage);
    const res = await app.request(RESOURCE);

    expect(res.status).toBe(200);
    expect(res.headers.get(ACCESS_GRANT_HEADER)).toBeNull();
  });

  it('402 response → no header', async () => {
    const storage = new AzethSIWxStorage({ publicClient: mockPublicClient, servicePayee: SERVICE_PAYEE });

    const app = makeApp(storage, { status: 402 });
    const res = await app.request(RESOURCE, { headers: { 'sign-in-with-x': siwxHeader(USER_ADDRESS) } });

    expect(res.status).toBe(402);
    expect(res.headers.get(ACCESS_GRANT_HEADER)).toBeNull();
  });

  it('PAYMENT-RESPONSE present (fresh settlement) → no header', async () => {
    const storage = new AzethSIWxStorage({ publicClient: mockPublicClient, servicePayee: SERVICE_PAYEE });
    storage.recordPayment(RESOURCE, USER_ADDRESS);
    await storage.hasPaid(RESOURCE, USER_ADDRESS);

    const app = makeApp(storage, { paymentResponse: true });
    const res = await app.request(RESOURCE, { headers: { 'sign-in-with-x': siwxHeader(USER_ADDRESS) } });

    expect(res.status).toBe(200);
    expect(res.headers.get('PAYMENT-RESPONSE')).toBe('encoded-settlement');
    expect(res.headers.get(ACCESS_GRANT_HEADER)).toBeNull();
  });

  it('preSettledVerified set (fresh pre-settled settlement) → no header', async () => {
    const storage = new AzethSIWxStorage({ publicClient: mockPublicClient, servicePayee: SERVICE_PAYEE });
    storage.recordPayment(RESOURCE, USER_ADDRESS);
    await storage.hasPaid(RESOURCE, USER_ADDRESS);

    const app = makeApp(storage, { preSettled: true });
    const res = await app.request(RESOURCE, { headers: { 'sign-in-with-x': siwxHeader(USER_ADDRESS) } });

    expect(res.status).toBe(200);
    expect(res.headers.get(ACCESS_GRANT_HEADER)).toBeNull();
  });

  it('malformed SIWx header (not base64) → no header, no throw, response untouched', async () => {
    const storage = new AzethSIWxStorage({ publicClient: mockPublicClient, servicePayee: SERVICE_PAYEE });

    const app = makeApp(storage);
    const res = await app.request(RESOURCE, { headers: { 'sign-in-with-x': '!!not-valid-base64!!' } });

    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
    expect(res.headers.get(ACCESS_GRANT_HEADER)).toBeNull();
  });

  it('malformed SIWx header (base64 of invalid payload) → no header, no throw', async () => {
    const storage = new AzethSIWxStorage({ publicClient: mockPublicClient, servicePayee: SERVICE_PAYEE });

    const app = makeApp(storage);
    const badPayload = Buffer.from(JSON.stringify({ nope: true })).toString('base64');
    const res = await app.request(RESOURCE, { headers: { 'sign-in-with-x': badPayload } });

    expect(res.status).toBe(200);
    expect(res.headers.get(ACCESS_GRANT_HEADER)).toBeNull();
  });
});
