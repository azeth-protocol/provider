import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PublicClient, Chain, Transport } from 'viem';

vi.mock('../../src/agreement-cache.js', () => ({
  findActiveAgreementForPayee: vi.fn(),
  clearAgreementCache: vi.fn(),
  setAgreementCacheTtl: vi.fn(),
}));

import { findActiveAgreementForPayee } from '../../src/agreement-cache.js';
import { AzethSIWxStorage } from '../../src/storage.js';

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
