import type { PublicClient, Chain, Transport } from 'viem';
import { PaymentAgreementModuleAbi } from '@azeth/common/abis';
import type { PaymentAgreement } from '@azeth/common';

/** Cached agreement entry with LRU tracking and executability */
interface CachedAgreement {
  agreement: PaymentAgreement;
  executable: boolean;
  reason: string;
  isDue: boolean;
  nextExecutionTime: bigint;
  count: bigint;
  fetchedAt: number;
  lastAccessedAt: number;
}

const _agreementCache = new Map<string, CachedAgreement>();
let _cacheTtlMs = 60_000; // 60 seconds default
const MAX_CACHE_SIZE = 5_000;

/** Set the cache TTL (useful for tests) */
export function setAgreementCacheTtl(ttlMs: number): void {
  _cacheTtlMs = ttlMs;
}

/** Clear the agreement cache */
export function clearAgreementCache(): void {
  _agreementCache.clear();
}

/** Get a cached agreement with executability, fetching from chain if stale or missing.
 *  Uses getAgreementData for a single RPC call instead of 3 separate calls.
 *  Returns stale cache on RPC error (stale-on-error pattern). */
async function getCachedAgreement(
  publicClient: PublicClient<Transport, Chain>,
  moduleAddress: `0x${string}`,
  account: `0x${string}`,
  agreementId: bigint,
): Promise<CachedAgreement | null> {
  const key = `${account.toLowerCase()}:${agreementId.toString()}`;
  const cached = _agreementCache.get(key);
  const now = Date.now();

  if (cached && (now - cached.fetchedAt) < _cacheTtlMs) {
    cached.lastAccessedAt = now;
    return cached;
  }

  try {
    const result = await publicClient.readContract({
      address: moduleAddress,
      abi: PaymentAgreementModuleAbi,
      functionName: 'getAgreementData',
      args: [account, agreementId],
    }) as unknown as readonly [
      {
        payee: `0x${string}`;
        token: `0x${string}`;
        amount: bigint;
        interval: bigint;
        endTime: bigint;
        lastExecuted: bigint;
        maxExecutions: bigint;
        executionCount: bigint;
        totalCap: bigint;
        totalPaid: bigint;
        active: boolean;
      },
      boolean,
      string,
      boolean,
      bigint,
      bigint,
    ];

    const agreement: PaymentAgreement = {
      id: agreementId,
      payee: result[0].payee,
      token: result[0].token,
      amount: result[0].amount,
      interval: result[0].interval,
      endTime: result[0].endTime,
      lastExecuted: result[0].lastExecuted,
      maxExecutions: result[0].maxExecutions,
      executionCount: result[0].executionCount,
      totalCap: result[0].totalCap,
      totalPaid: result[0].totalPaid,
      active: result[0].active,
    };

    const entry: CachedAgreement = {
      agreement,
      executable: result[1],
      reason: result[2],
      isDue: result[3],
      nextExecutionTime: result[4],
      count: result[5],
      fetchedAt: now,
      lastAccessedAt: now,
    };

    // LRU eviction if at capacity
    if (_agreementCache.size >= MAX_CACHE_SIZE && !_agreementCache.has(key)) {
      let lruKey: string | undefined;
      let lruTime = Infinity;
      for (const [k, v] of _agreementCache) {
        if (v.lastAccessedAt < lruTime) {
          lruTime = v.lastAccessedAt;
          lruKey = k;
        }
      }
      if (lruKey !== undefined) _agreementCache.delete(lruKey);
    }

    _agreementCache.set(key, entry);
    return entry;
  } catch {
    // Stale-on-error: return stale cache if available (optimistic grant)
    return cached ?? null;
  }
}

/** Check if an agreement is currently active and valid (metadata only — no balance check) */
function isAgreementValid(
  agreement: PaymentAgreement,
  payee: `0x${string}`,
  token?: `0x${string}`,
  minAmount?: bigint,
): boolean {
  if (!agreement.active) return false;
  if (agreement.payee.toLowerCase() !== payee.toLowerCase()) return false;
  if (token && agreement.token.toLowerCase() !== token.toLowerCase()) return false;
  if (minAmount && agreement.amount < minAmount) return false;

  const now = BigInt(Math.floor(Date.now() / 1000));

  // Check expiry (0 = no expiry)
  if (agreement.endTime !== 0n && agreement.endTime <= now) return false;

  // Check max executions (0 = unlimited)
  if (agreement.maxExecutions !== 0n && agreement.executionCount >= agreement.maxExecutions) return false;

  // Check total cap (0 = unlimited) — defense-in-depth alongside contract's executable flag
  if (agreement.totalCap !== 0n && agreement.totalPaid >= agreement.totalCap) return false;

  return true;
}

/** Find an active, executable agreement from a given account to a specific payee.
 *  Uses getAgreementData for combined agreement + executability + count in 1 RPC call.
 *  Iterates from newest to oldest (newest more likely active).
 *
 *  @param publicClient - viem public client for on-chain reads
 *  @param moduleAddress - PaymentAgreementModule contract address
 *  @param account - The payer's smart account address
 *  @param payee - The payee address to match
 *  @param token - Optional token address to match
 *  @param minAmount - Optional minimum amount per interval
 *  @returns The first matching active + executable agreement, or null
 */
export async function findActiveAgreementForPayee(
  publicClient: PublicClient<Transport, Chain>,
  moduleAddress: `0x${string}`,
  account: `0x${string}`,
  payee: `0x${string}`,
  token?: `0x${string}`,
  minAmount?: bigint,
): Promise<PaymentAgreement | null> {
  // Get count from first getAgreementData call (avoids separate getAgreementCount RPC)
  // Start with agreementId=0 to get the count, then iterate from newest
  const first = await getCachedAgreement(publicClient, moduleAddress, account, 0n);
  if (!first) return null;

  const count = first.count;
  if (count === 0n) return null;

  // Iterate from newest to oldest
  for (let i = count - 1n; i >= 0n; i--) {
    const cached = await getCachedAgreement(publicClient, moduleAddress, account, i);
    if (!cached) continue;

    if (!isAgreementValid(cached.agreement, payee, token, minAmount)) continue;

    // Check executability (balance + guardian checks) — already in cache, no extra RPC
    if (!cached.executable) continue;

    return cached.agreement;
  }

  return null;
}
