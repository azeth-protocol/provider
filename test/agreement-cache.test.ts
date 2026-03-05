import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PublicClient, Chain, Transport } from 'viem';

vi.mock('@azeth/common/abis', () => ({ PaymentAgreementModuleAbi: [] }));

import {
  findActiveAgreementForPayee,
  clearAgreementCache,
  setAgreementCacheTtl,
} from '../src/agreement-cache.js';

// ── Constants ──

const MODULE_ADDRESS = '0x9999999999999999999999999999999999999999' as `0x${string}`;
const ACCOUNT = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const PAYEE = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`;

// ── Helpers ──

function createMockPublicClient() {
  return {
    readContract: vi.fn(),
    chain: { id: 84532 },
  } as unknown as PublicClient<Transport, Chain>;
}

/** Build a getAgreementData return tuple: [agreementStruct, executable, reason, isDue, nextExecutionTime, count] */
function makeAgreementDataResult(
  overrides: Partial<Record<string, unknown>> = {},
  executable = true,
  count = 1n,
  reason = '',
  isDue = true,
  nextExecutionTime = BigInt(Math.floor(Date.now() / 1000)),
) {
  const agreement = {
    payee: PAYEE,
    token: TOKEN,
    amount: 10000n,
    interval: 86400n,
    endTime: 0n,
    lastExecuted: BigInt(Math.floor(Date.now() / 1000) - 100),
    maxExecutions: 0n,
    executionCount: 0n,
    totalCap: 0n,
    totalPaid: 0n,
    active: true,
    ...overrides,
  };
  return [agreement, executable, reason, isDue, nextExecutionTime, count] as const;
}

// ── Tests ──

describe('Agreement Cache', () => {
  let client: ReturnType<typeof createMockPublicClient>;
  let readContract: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearAgreementCache();
    setAgreementCacheTtl(60_000);
    client = createMockPublicClient();
    readContract = client.readContract as unknown as ReturnType<typeof vi.fn>;
  });

  // 1. Matching active + executable agreement
  it('should return a matching active and executable agreement', async () => {
    // getAgreementData(account, 0) — returns agreement + executable + count
    readContract.mockResolvedValue(makeAgreementDataResult());

    const result = await findActiveAgreementForPayee(
      client, MODULE_ADDRESS, ACCOUNT, PAYEE,
    );

    expect(result).not.toBeNull();
    expect(result!.payee).toBe(PAYEE);
    expect(result!.token).toBe(TOKEN);
    expect(result!.amount).toBe(10000n);
    expect(result!.active).toBe(true);
    expect(result!.id).toBe(0n);
  });

  // 2. No agreements (count = 0)
  it('should return null when agreement count is zero', async () => {
    // getAgreementData returns count=0
    readContract.mockResolvedValue(makeAgreementDataResult({}, false, 0n));

    const result = await findActiveAgreementForPayee(
      client, MODULE_ADDRESS, ACCOUNT, PAYEE,
    );

    expect(result).toBeNull();
  });

  // 3. No matching payee
  it('should return null when no agreement matches the payee', async () => {
    const otherPayee = '0x3333333333333333333333333333333333333333' as `0x${string}`;

    readContract.mockResolvedValue(makeAgreementDataResult({ payee: otherPayee }));

    const result = await findActiveAgreementForPayee(
      client, MODULE_ADDRESS, ACCOUNT, PAYEE,
    );

    expect(result).toBeNull();
  });

  // 4. Expired agreement
  it('should return null for an expired agreement', async () => {
    const expiredTime = BigInt(Math.floor(Date.now() / 1000) - 86400);

    readContract.mockResolvedValue(makeAgreementDataResult({ endTime: expiredTime }));

    const result = await findActiveAgreementForPayee(
      client, MODULE_ADDRESS, ACCOUNT, PAYEE,
    );

    expect(result).toBeNull();
  });

  // 5. Inactive agreement
  it('should return null for an inactive agreement', async () => {
    readContract.mockResolvedValue(makeAgreementDataResult({ active: false }, false));

    const result = await findActiveAgreementForPayee(
      client, MODULE_ADDRESS, ACCOUNT, PAYEE,
    );

    expect(result).toBeNull();
  });

  // 6. Max executions exceeded
  it('should return null when maxExecutions is reached', async () => {
    readContract.mockResolvedValue(makeAgreementDataResult({
      maxExecutions: 5n,
      executionCount: 5n,
    }, false));

    const result = await findActiveAgreementForPayee(
      client, MODULE_ADDRESS, ACCOUNT, PAYEE,
    );

    expect(result).toBeNull();
  });

  // 7. Amount below minimum
  it('should return null when amount is below minAmount', async () => {
    readContract.mockResolvedValue(makeAgreementDataResult({ amount: 500n }));

    const result = await findActiveAgreementForPayee(
      client, MODULE_ADDRESS, ACCOUNT, PAYEE, undefined, 1000n,
    );

    expect(result).toBeNull();
  });

  // 8. Agreement not executable (insufficient balance) — returns null
  it('should return null when agreement is not executable (insufficient balance)', async () => {
    // Agreement metadata is valid but executable=false (balance or guardian issue)
    readContract.mockResolvedValue(makeAgreementDataResult({}, false));

    const result = await findActiveAgreementForPayee(
      client, MODULE_ADDRESS, ACCOUNT, PAYEE,
    );

    expect(result).toBeNull();
  });

  // 9. First agreement non-executable, falls through to second
  it('should skip non-executable agreement and return next executable one', async () => {
    readContract.mockImplementation(async (args: any) => {
      const agreementId = args.args[1] as bigint;
      if (agreementId === 1n) {
        // Newest agreement: valid metadata but not executable
        return makeAgreementDataResult({}, false, 2n);
      }
      // Oldest agreement: valid and executable
      return makeAgreementDataResult({}, true, 2n);
    });

    const result = await findActiveAgreementForPayee(
      client, MODULE_ADDRESS, ACCOUNT, PAYEE,
    );

    expect(result).not.toBeNull();
    expect(result!.id).toBe(0n);
  });

  // 10. Cache hit -- second call does not make new RPC call for agreement
  it('should serve from cache on second call without re-reading', async () => {
    setAgreementCacheTtl(100);

    readContract.mockResolvedValue(makeAgreementDataResult());

    const first = await findActiveAgreementForPayee(
      client, MODULE_ADDRESS, ACCOUNT, PAYEE,
    );
    const second = await findActiveAgreementForPayee(
      client, MODULE_ADDRESS, ACCOUNT, PAYEE,
    );

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.payee).toBe(second!.payee);
    // Only 1 RPC call total — both first.getAgreementData(0) returns count,
    // and the agreement itself is cached for the second call
    expect(readContract).toHaveBeenCalledTimes(1);
  });

  // 11. Stale-on-error -- returns stale cache when RPC fails
  it('should return stale cached agreement when RPC call fails', async () => {
    setAgreementCacheTtl(100);

    // First call succeeds and primes the cache
    readContract.mockResolvedValueOnce(makeAgreementDataResult());

    const first = await findActiveAgreementForPayee(
      client, MODULE_ADDRESS, ACCOUNT, PAYEE,
    );
    expect(first).not.toBeNull();

    // Wait for cache to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Second call: getAgreementData fails
    readContract.mockRejectedValueOnce(new Error('RPC timeout'));

    const second = await findActiveAgreementForPayee(
      client, MODULE_ADDRESS, ACCOUNT, PAYEE,
    );

    // Should return the stale cached agreement (optimistic grant)
    expect(second).not.toBeNull();
    expect(second!.payee).toBe(PAYEE);
    expect(second!.amount).toBe(10000n);
  });

  // 12. Executability re-verified when cache expires
  it('should re-verify executability when cache entry expires', async () => {
    setAgreementCacheTtl(100);

    // First call: executable
    readContract.mockResolvedValueOnce(makeAgreementDataResult({}, true));

    const first = await findActiveAgreementForPayee(
      client, MODULE_ADDRESS, ACCOUNT, PAYEE,
    );
    expect(first).not.toBeNull();

    // Wait for cache to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Second call: same agreement is now non-executable (balance drained)
    readContract.mockResolvedValueOnce(makeAgreementDataResult({}, false));

    const second = await findActiveAgreementForPayee(
      client, MODULE_ADDRESS, ACCOUNT, PAYEE,
    );
    expect(second).toBeNull();
  });

  // 13. clearAgreementCache and setAgreementCacheTtl work
  it('should clear the cache so next call re-fetches, and respect TTL changes', async () => {
    setAgreementCacheTtl(100);

    readContract
      .mockResolvedValueOnce(makeAgreementDataResult({ amount: 1000n }))
      .mockResolvedValueOnce(makeAgreementDataResult({ amount: 2000n }));

    // First call primes the cache
    const first = await findActiveAgreementForPayee(
      client, MODULE_ADDRESS, ACCOUNT, PAYEE,
    );
    expect(first!.amount).toBe(1000n);

    // Clear cache -- forces re-fetch
    clearAgreementCache();

    const second = await findActiveAgreementForPayee(
      client, MODULE_ADDRESS, ACCOUNT, PAYEE,
    );
    expect(second!.amount).toBe(2000n);

    // 2 RPC calls total (1 per findActiveAgreementForPayee after cache clear)
    expect(readContract).toHaveBeenCalledTimes(2);
  });
});
