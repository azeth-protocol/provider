import type { PublicClient, Chain, Transport } from 'viem';
import type { SIWxStorage } from '@x402/extensions/sign-in-with-x';
import { findActiveAgreementForPayee } from './agreement-cache.js';
import type { AgreementKeeper } from './agreement-keeper.js';

/** Configuration for agreement-aware SIWx storage */
export interface AzethSIWxStorageConfig {
  /** viem public client for on-chain reads */
  publicClient: PublicClient<Transport, Chain>;
  /** The service's payment recipient address */
  servicePayee: `0x${string}`;
  /** Token address the service accepts (e.g., USDC) */
  serviceToken?: `0x${string}`;
  /** PaymentAgreementModule contract address */
  moduleAddress?: `0x${string}`;
  /** Minimum agreement amount per interval */
  minAgreementAmount?: bigint;
}

/** Agreement-aware SIWx storage.
 *
 *  Implements the @x402/extensions SIWxStorage interface with two-tier lookup:
 *  1. In-memory payment records (from x402 settlement — previously paid)
 *  2. On-chain payment agreements (subscription — no per-request payment needed)
 *
 *  This is the key integration point between x402 SIWx sessions and Azeth
 *  payment agreements. Both use SIWx for wallet identity — the difference
 *  is what hasPaid() checks.
 */
/** Max entries per resource in paymentRecords to prevent unbounded growth */
const MAX_PAYMENT_RECORDS_PER_RESOURCE = 100_000;

/** Max grant-kind entries to prevent unbounded growth (FIFO eviction, same pattern as recordNonce) */
const MAX_GRANT_KINDS = 10_000;

/** How a hasPaid() grant was satisfied: a prior payment record (session) or an on-chain agreement */
export type GrantKind = 'session' | 'agreement';

export class AzethSIWxStorage implements SIWxStorage {
  private readonly paymentRecords = new Map<string, Set<string>>();
  private readonly usedNonces = new Set<string>();
  /** Which tier satisfied the most recent hasPaid() grant, keyed per `${resource}:${address}` */
  private readonly grantKinds = new Map<string, GrantKind>();
  private readonly config: AzethSIWxStorageConfig;
  private keeper: AgreementKeeper | null = null;

  constructor(config: AzethSIWxStorageConfig) {
    this.config = config;
  }

  /** Inject the agreement keeper after construction.
   *  Called from server startup to avoid circular initialization. */
  setKeeper(keeper: AgreementKeeper): void {
    this.keeper = keeper;
  }

  /** Check if an address has paid for a resource.
   *
   *  Two-tier lookup:
   *  1. Check in-memory payment records (x402 settlement — permanent grant)
   *  2. Check on-chain agreements (subscription — re-verified every ~60s via cache TTL)
   *
   *  Settlement grants (recordPayment) are permanent for the session.
   *  Agreement grants are NOT cached permanently — they are re-verified on each
   *  call via findActiveAgreementForPayee (which uses a 60s TTL cache internally).
   *  This ensures that if a payer's balance drops to zero, their access is revoked
   *  within ~60s instead of being permanently granted.
   */
  async hasPaid(resource: string, address: string): Promise<boolean> {
    const normalized = address.toLowerCase();

    // 1. Check in-memory payment records (fast path — settlement grants are permanent)
    const set = this.paymentRecords.get(resource);
    if (set?.has(normalized)) {
      this.recordGrantKind(resource, normalized, 'session');
      return true;
    }

    // 2. Check on-chain agreements (re-verified via agreementCache with 60s TTL)
    if (this.config.moduleAddress) {
      try {
        const agreement = await findActiveAgreementForPayee(
          this.config.publicClient,
          this.config.moduleAddress,
          address as `0x${string}`,
          this.config.servicePayee,
          this.config.serviceToken,
          this.config.minAgreementAmount,
        );
        if (agreement) {
          // Notify keeper to track this agreement for periodic execution
          this.keeper?.trackAgreement(
            address as `0x${string}`,
            agreement.id,
          );
          this.recordGrantKind(resource, normalized, 'agreement');
          return true;
        }
      } catch {
        // Agreement check failure is non-fatal — fall through to 402
      }
    }

    return false;
  }

  /** Record that an address has paid for a resource */
  recordPayment(resource: string, address: string): void {
    this.recordPaymentSync(resource, address.toLowerCase());
  }

  /** Check if a nonce has been used (replay prevention) */
  hasUsedNonce(nonce: string): boolean {
    return this.usedNonces.has(nonce);
  }

  /** Record a nonce as used */
  recordNonce(nonce: string): void {
    this.usedNonces.add(nonce);
    // Limit nonce set size to prevent unbounded growth
    if (this.usedNonces.size > 50_000) {
      const iterator = this.usedNonces.values();
      const oldest = iterator.next().value;
      if (oldest !== undefined) this.usedNonces.delete(oldest);
    }
  }

  /** Look up which tier satisfied the most recent hasPaid() grant for a resource+address.
   *
   *  Keyed per resource+address (never "last grant globally") so two concurrent
   *  payers on the same resource can never cross-label each other.
   *
   *  @param resource - Resource path (pathname, same key hasPaid uses)
   *  @param address - Payer address (case-insensitive)
   *  @returns 'session' (prior payment record), 'agreement' (on-chain agreement),
   *           or undefined if hasPaid never granted for this pair
   */
  getGrantKind(resource: string, address: string): GrantKind | undefined {
    return this.grantKinds.get(`${resource}:${address.toLowerCase()}`);
  }

  /** Record which tier satisfied a hasPaid() grant, with FIFO eviction */
  private recordGrantKind(resource: string, normalized: string, kind: GrantKind): void {
    this.grantKinds.set(`${resource}:${normalized}`, kind);
    // Limit map size to prevent unbounded growth (same pattern as recordNonce)
    if (this.grantKinds.size > MAX_GRANT_KINDS) {
      const oldest = this.grantKinds.keys().next().value;
      if (oldest !== undefined) this.grantKinds.delete(oldest);
    }
  }

  /** Synchronous payment record helper */
  private recordPaymentSync(resource: string, normalized: string): void {
    let set = this.paymentRecords.get(resource);
    if (!set) {
      set = new Set();
      this.paymentRecords.set(resource, set);
    }
    set.add(normalized);
    // Evict oldest entry when cap reached to prevent unbounded memory growth
    if (set.size > MAX_PAYMENT_RECORDS_PER_RESOURCE) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
  }
}
