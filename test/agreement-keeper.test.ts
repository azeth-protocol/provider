import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PublicClient, WalletClient, Chain, Transport, Account } from 'viem';
import { AgreementKeeper } from '../src/agreement-keeper.js';

const MODULE_ADDRESS = '0x9999999999999999999999999999999999999999' as `0x${string}`;
const ACCOUNT_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as `0x${string}`;
const ACCOUNT_B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as `0x${string}`;

describe('AgreementKeeper', () => {
  let mockPublicClient: PublicClient<Transport, Chain>;
  let mockWalletClient: WalletClient<Transport, Chain, Account>;
  let keeper: AgreementKeeper;

  beforeEach(() => {
    vi.useFakeTimers();
    mockPublicClient = {
      readContract: vi.fn().mockResolvedValue([false, 'interval not elapsed']),
    } as unknown as PublicClient<Transport, Chain>;
    mockWalletClient = {
      writeContract: vi.fn().mockResolvedValue('0xtxhash'),
    } as unknown as WalletClient<Transport, Chain, Account>;
    keeper = new AgreementKeeper({
      publicClient: mockPublicClient,
      walletClient: mockWalletClient,
      moduleAddress: MODULE_ADDRESS,
      scanIntervalMs: 1000, // 1s for tests
      maxExecutionsPerScan: 5,
    });
  });

  afterEach(() => {
    keeper.stop();
    vi.useRealTimers();
  });

  it('trackAgreement adds to tracked set', () => {
    expect(keeper.trackedCount).toBe(0);

    keeper.trackAgreement(ACCOUNT_A, 0n);
    expect(keeper.trackedCount).toBe(1);

    // Duplicate is idempotent
    keeper.trackAgreement(ACCOUNT_A, 0n);
    expect(keeper.trackedCount).toBe(1);

    // Different agreement
    keeper.trackAgreement(ACCOUNT_A, 1n);
    expect(keeper.trackedCount).toBe(2);

    // Different account
    keeper.trackAgreement(ACCOUNT_B, 0n);
    expect(keeper.trackedCount).toBe(3);
  });

  it('scan calls canExecutePayment for each tracked agreement', async () => {
    keeper.trackAgreement(ACCOUNT_A, 0n);
    keeper.trackAgreement(ACCOUNT_B, 1n);

    await keeper.scan();

    expect(mockPublicClient.readContract).toHaveBeenCalledTimes(2);
    expect(mockPublicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: MODULE_ADDRESS,
        functionName: 'canExecutePayment',
        args: [ACCOUNT_A, 0n],
      }),
    );
    expect(mockPublicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: MODULE_ADDRESS,
        functionName: 'canExecutePayment',
        args: [ACCOUNT_B, 1n],
      }),
    );
  });

  it('scan executes due agreements', async () => {
    (mockPublicClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue([true, '']);

    keeper.trackAgreement(ACCOUNT_A, 0n);

    await keeper.scan();

    expect(mockWalletClient.writeContract).toHaveBeenCalledTimes(1);
    expect(mockWalletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: MODULE_ADDRESS,
        functionName: 'executeAgreement',
        args: [ACCOUNT_A, 0n],
      }),
    );
  });

  it('scan skips non-due agreements', async () => {
    // canExecutePayment returns [false, reason]
    (mockPublicClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue([false, 'interval not elapsed']);

    keeper.trackAgreement(ACCOUNT_A, 0n);

    await keeper.scan();

    expect(mockPublicClient.readContract).toHaveBeenCalledTimes(1);
    expect(mockWalletClient.writeContract).not.toHaveBeenCalled();
  });

  it('scan removes completed agreements from tracking', async () => {
    (mockPublicClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue([false, 'not active']);

    keeper.trackAgreement(ACCOUNT_A, 0n);
    expect(keeper.trackedCount).toBe(1);

    await keeper.scan();

    // Agreement should be removed from tracking
    expect(keeper.trackedCount).toBe(0);
    expect(mockWalletClient.writeContract).not.toHaveBeenCalled();
  });

  it('scan removes max-executions-reached agreements from tracking', async () => {
    (mockPublicClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue([false, 'max executions reached']);

    keeper.trackAgreement(ACCOUNT_A, 0n);
    expect(keeper.trackedCount).toBe(1);

    await keeper.scan();

    expect(keeper.trackedCount).toBe(0);
  });

  it('scan keeps interval-not-elapsed agreements in tracking', async () => {
    (mockPublicClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue([false, 'interval not elapsed']);

    keeper.trackAgreement(ACCOUNT_A, 0n);
    expect(keeper.trackedCount).toBe(1);

    await keeper.scan();

    // Should still be tracked — just not due yet
    expect(keeper.trackedCount).toBe(1);
  });

  it('scan continues after individual execution failure', async () => {
    (mockPublicClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue([true, '']);

    // First execution fails, second succeeds
    (mockWalletClient.writeContract as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('gas estimation failed'))
      .mockResolvedValueOnce('0xtxhash');

    keeper.trackAgreement(ACCOUNT_A, 0n);
    keeper.trackAgreement(ACCOUNT_B, 1n);

    // Should not throw
    await keeper.scan();

    // Both should have been attempted
    expect(mockPublicClient.readContract).toHaveBeenCalledTimes(2);
    expect(mockWalletClient.writeContract).toHaveBeenCalledTimes(2);
  });

  it('scan respects maxExecutionsPerScan cap', async () => {
    (mockPublicClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue([true, '']);

    // Track 10 agreements but cap is 5
    for (let i = 0; i < 10; i++) {
      keeper.trackAgreement(ACCOUNT_A, BigInt(i));
    }

    await keeper.scan();

    // Should cap at 5 executions
    expect(mockWalletClient.writeContract).toHaveBeenCalledTimes(5);
  });

  it('start/stop lifecycle', () => {
    keeper.start();
    // Starting again is idempotent
    keeper.start();

    keeper.stop();
    // Stopping again is idempotent
    keeper.stop();
  });

  it('scan runs periodically after start', async () => {
    (mockPublicClient.readContract as ReturnType<typeof vi.fn>).mockResolvedValue([true, '']);
    keeper.trackAgreement(ACCOUNT_A, 0n);

    keeper.start();

    // Advance past the scan interval
    await vi.advanceTimersByTimeAsync(1100);

    expect(mockPublicClient.readContract).toHaveBeenCalled();
  });
});
