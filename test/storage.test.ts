import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PublicClient, Chain, Transport } from 'viem';

vi.mock('../src/agreement-cache.js', () => ({
  findActiveAgreementForPayee: vi.fn(),
}));

import { findActiveAgreementForPayee } from '../src/agreement-cache.js';
import { AzethSIWxStorage } from '../src/storage.js';

const mockFindAgreement = vi.mocked(findActiveAgreementForPayee);
const mockPublicClient = {} as PublicClient<Transport, Chain>;

const SERVICE_PAYEE = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const MODULE_ADDRESS = '0x9999999999999999999999999999999999999999' as `0x${string}`;
const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`;
const USER_ADDRESS = '0x1111111111111111111111111111111111111111';
const RESOURCE = '/api/v1/pricing/bitcoin';

const MOCK_AGREEMENT = {
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

describe('AzethSIWxStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hasPaid returns false for unknown address when no module configured', async () => {
    const storage = new AzethSIWxStorage({
      publicClient: mockPublicClient,
      servicePayee: SERVICE_PAYEE,
    });

    const result = await storage.hasPaid(RESOURCE, USER_ADDRESS);

    expect(result).toBe(false);
    expect(mockFindAgreement).not.toHaveBeenCalled();
  });

  it('hasPaid returns true after recordPayment (settlement grant is permanent)', async () => {
    const storage = new AzethSIWxStorage({
      publicClient: mockPublicClient,
      servicePayee: SERVICE_PAYEE,
    });

    storage.recordPayment(RESOURCE, USER_ADDRESS);
    const result = await storage.hasPaid(RESOURCE, USER_ADDRESS);

    expect(result).toBe(true);
  });

  it('hasPaid normalizes address to lowercase', async () => {
    const storage = new AzethSIWxStorage({
      publicClient: mockPublicClient,
      servicePayee: SERVICE_PAYEE,
    });

    const mixedCase = '0x1111111111111111111111111111111111111111';
    const upperCase = '0x1111111111111111111111111111111111111111'.toUpperCase().replace('0X', '0x');

    storage.recordPayment(RESOURCE, mixedCase);

    // Querying with different casing should still match
    const result = await storage.hasPaid(RESOURCE, upperCase);
    expect(result).toBe(true);
  });

  it('hasPaid checks on-chain agreements and re-verifies on each call (no permanent cache)', async () => {
    const storage = new AzethSIWxStorage({
      publicClient: mockPublicClient,
      servicePayee: SERVICE_PAYEE,
      serviceToken: TOKEN,
      moduleAddress: MODULE_ADDRESS,
      minAgreementAmount: 1000n,
    });

    // First call: agreement found
    mockFindAgreement.mockResolvedValueOnce(MOCK_AGREEMENT);

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

    // Second call: agreement still found — re-verified via findActiveAgreementForPayee
    mockFindAgreement.mockResolvedValueOnce(MOCK_AGREEMENT);
    const secondResult = await storage.hasPaid(RESOURCE, USER_ADDRESS);
    expect(secondResult).toBe(true);
    // findActiveAgreementForPayee called TWICE (once per hasPaid)
    expect(mockFindAgreement).toHaveBeenCalledTimes(2);
  });

  it('agreement becomes non-executable → hasPaid returns false', async () => {
    const storage = new AzethSIWxStorage({
      publicClient: mockPublicClient,
      servicePayee: SERVICE_PAYEE,
      serviceToken: TOKEN,
      moduleAddress: MODULE_ADDRESS,
    });

    // First call: agreement found and executable
    mockFindAgreement.mockResolvedValueOnce(MOCK_AGREEMENT);
    expect(await storage.hasPaid(RESOURCE, USER_ADDRESS)).toBe(true);

    // Second call: agreement no longer found (balance drained → not executable)
    mockFindAgreement.mockResolvedValueOnce(null);
    expect(await storage.hasPaid(RESOURCE, USER_ADDRESS)).toBe(false);
  });

  it('settlement-paid client unaffected by agreement state', async () => {
    const storage = new AzethSIWxStorage({
      publicClient: mockPublicClient,
      servicePayee: SERVICE_PAYEE,
      moduleAddress: MODULE_ADDRESS,
    });

    // Record a settlement payment (permanent grant)
    storage.recordPayment(RESOURCE, USER_ADDRESS);

    // Settlement grant is permanent — doesn't call findActiveAgreementForPayee
    const result = await storage.hasPaid(RESOURCE, USER_ADDRESS);
    expect(result).toBe(true);
    expect(mockFindAgreement).not.toHaveBeenCalled();
  });

  it('hasPaid returns false when no agreement found on-chain', async () => {
    const storage = new AzethSIWxStorage({
      publicClient: mockPublicClient,
      servicePayee: SERVICE_PAYEE,
      moduleAddress: MODULE_ADDRESS,
    });

    mockFindAgreement.mockResolvedValueOnce(null);

    const result = await storage.hasPaid(RESOURCE, USER_ADDRESS);

    expect(result).toBe(false);
    expect(mockFindAgreement).toHaveBeenCalledOnce();
  });

  it('hasPaid catches errors from agreement check (non-fatal)', async () => {
    const storage = new AzethSIWxStorage({
      publicClient: mockPublicClient,
      servicePayee: SERVICE_PAYEE,
      moduleAddress: MODULE_ADDRESS,
    });

    mockFindAgreement.mockRejectedValueOnce(new Error('RPC timeout'));

    const result = await storage.hasPaid(RESOURCE, USER_ADDRESS);

    expect(result).toBe(false);
    expect(mockFindAgreement).toHaveBeenCalledOnce();
  });

  it('hasUsedNonce and recordNonce track nonces correctly', () => {
    const storage = new AzethSIWxStorage({
      publicClient: mockPublicClient,
      servicePayee: SERVICE_PAYEE,
    });

    expect(storage.hasUsedNonce('nonce-1')).toBe(false);

    storage.recordNonce('nonce-1');
    expect(storage.hasUsedNonce('nonce-1')).toBe(true);

    // Different nonce is still unused
    expect(storage.hasUsedNonce('nonce-2')).toBe(false);

    storage.recordNonce('nonce-2');
    expect(storage.hasUsedNonce('nonce-2')).toBe(true);
  });

  it('hasPaid notifies keeper when agreement is discovered', async () => {
    const storage = new AzethSIWxStorage({
      publicClient: mockPublicClient,
      servicePayee: SERVICE_PAYEE,
      serviceToken: TOKEN,
      moduleAddress: MODULE_ADDRESS,
      minAgreementAmount: 1000n,
    });

    // Create a mock keeper
    const mockKeeper = {
      trackAgreement: vi.fn(),
    };
    storage.setKeeper(mockKeeper as any);

    mockFindAgreement.mockResolvedValueOnce({
      ...MOCK_AGREEMENT,
      id: 42n,
    });

    const result = await storage.hasPaid(RESOURCE, USER_ADDRESS);

    expect(result).toBe(true);
    expect(mockKeeper.trackAgreement).toHaveBeenCalledWith(
      USER_ADDRESS,
      42n,
    );
  });

  it('hasPaid does not notify keeper when no agreement found', async () => {
    const storage = new AzethSIWxStorage({
      publicClient: mockPublicClient,
      servicePayee: SERVICE_PAYEE,
      moduleAddress: MODULE_ADDRESS,
    });

    const mockKeeper = {
      trackAgreement: vi.fn(),
    };
    storage.setKeeper(mockKeeper as any);

    mockFindAgreement.mockResolvedValueOnce(null);

    const result = await storage.hasPaid(RESOURCE, USER_ADDRESS);

    expect(result).toBe(false);
    expect(mockKeeper.trackAgreement).not.toHaveBeenCalled();
  });

  it('recordNonce evicts oldest entry when limit exceeded', () => {
    const storage = new AzethSIWxStorage({
      publicClient: mockPublicClient,
      servicePayee: SERVICE_PAYEE,
    });

    // The limit is 50_000. We fill up to 50_001 to trigger eviction.
    for (let i = 0; i <= 50_000; i++) {
      storage.recordNonce(`nonce-${i}`);
    }

    // nonce-0 was the first inserted and should have been evicted
    expect(storage.hasUsedNonce('nonce-0')).toBe(false);

    // nonce-1 should still exist (it becomes the oldest after eviction)
    expect(storage.hasUsedNonce('nonce-1')).toBe(true);

    // The most recently added nonce should exist
    expect(storage.hasUsedNonce('nonce-50000')).toBe(true);
  });
});
