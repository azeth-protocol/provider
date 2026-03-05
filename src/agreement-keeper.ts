import type { PublicClient, WalletClient, Chain, Transport, Account } from 'viem';
import { PaymentAgreementModuleAbi } from '@azeth/common/abis';

/** Tracked agreement entry */
interface TrackedAgreement {
  account: `0x${string}`;
  agreementId: bigint;
  lastChecked: number;
}

/** Configuration for the AgreementKeeper */
export interface AgreementKeeperConfig {
  /** Public client for on-chain reads */
  publicClient: PublicClient<Transport, Chain>;
  /** Wallet client for gas settlement (facilitator wallet) */
  walletClient: WalletClient<Transport, Chain, Account>;
  /** PaymentAgreementModule contract address */
  moduleAddress: `0x${string}`;
  /** How often to scan for due agreements (ms). Default: 60_000 */
  scanIntervalMs?: number;
  /** Maximum executions per scan cycle. Default: 20 */
  maxExecutionsPerScan?: number;
}

/** AgreementKeeper — executes due payment agreements so services receive recurring revenue.
 *
 *  The keeper is notified when x402Storage.hasPaid() discovers an on-chain agreement.
 *  It periodically checks if tracked agreements are due for execution and calls
 *  executeAgreement() on the PaymentAgreementModule.
 *
 *  executeAgreement() is permissionless — anyone can call it — so the facilitator
 *  wallet only pays gas, not the agreement amount.
 */
export class AgreementKeeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly trackedAgreements = new Map<string, TrackedAgreement>();
  private readonly config: AgreementKeeperConfig;
  private readonly scanIntervalMs: number;
  private readonly maxExecutionsPerScan: number;

  constructor(config: AgreementKeeperConfig) {
    this.config = config;
    this.scanIntervalMs = config.scanIntervalMs ?? 60_000;
    this.maxExecutionsPerScan = config.maxExecutionsPerScan ?? 20;
  }

  /** Register an agreement for periodic execution.
   *  Called by x402Storage.hasPaid() when an agreement is discovered. */
  trackAgreement(account: `0x${string}`, agreementId: bigint): void {
    const key = `${account.toLowerCase()}:${agreementId}`;
    if (this.trackedAgreements.has(key)) return;
    this.trackedAgreements.set(key, {
      account,
      agreementId,
      lastChecked: 0,
    });
  }

  /** Number of tracked agreements */
  get trackedCount(): number {
    return this.trackedAgreements.size;
  }

  /** Start the periodic scan loop */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.scan().catch((err: unknown) => {
        console.error(
          '[AgreementKeeper] Scan error:',
          err instanceof Error ? err.message : err,
        );
      });
    }, this.scanIntervalMs);
    this.timer.unref();
  }

  /** Stop the keeper (for graceful shutdown) */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run a single scan: check + execute due agreements */
  async scan(): Promise<void> {
    let executed = 0;
    const keysToRemove: string[] = [];

    for (const [key, entry] of this.trackedAgreements) {
      if (executed >= this.maxExecutionsPerScan) break;

      try {
        // Check if the agreement is due for execution (view call, no gas)
        const result = await this.config.publicClient.readContract({
          address: this.config.moduleAddress,
          abi: PaymentAgreementModuleAbi,
          functionName: 'canExecutePayment',
          args: [entry.account, entry.agreementId],
        }) as readonly [boolean, string];

        const [executable, reason] = result;
        if (!executable) {
          entry.lastChecked = Date.now();
          // Remove completed/cancelled agreements from tracking to avoid unnecessary scans
          if (reason.includes('not active') || reason.includes('max executions') || reason.includes('total cap')) {
            keysToRemove.push(key);
          }
          continue;
        }

        // Execute the agreement (state-changing, requires gas)
        await this.config.walletClient.writeContract({
          address: this.config.moduleAddress,
          abi: PaymentAgreementModuleAbi,
          functionName: 'executeAgreement',
          args: [entry.account, entry.agreementId],
        });

        executed++;
        entry.lastChecked = Date.now();
        console.log(
          `[AgreementKeeper] Executed agreement ${entry.agreementId} for ${entry.account}`,
        );
      } catch (err: unknown) {
        // Individual failure is non-fatal — continue with other agreements
        console.warn(
          `[AgreementKeeper] Failed to execute agreement ${entry.agreementId} for ${entry.account}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Clean up completed/cancelled agreements after iteration
    for (const key of keysToRemove) {
      this.trackedAgreements.delete(key);
    }
  }
}
