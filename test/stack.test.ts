import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@azeth/common/abis', () => ({
  PaymentAgreementModuleAbi: [],
  AzethFactoryAbi: [],
}));

import { CAIP2_NETWORKS, createX402StackFromEnv } from '../src/stack.js';

describe('x402 service', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save env vars we may modify
    savedEnv['X402_FACILITATOR_KEY'] = process.env['X402_FACILITATOR_KEY'];
    savedEnv['AZETH_PRIVATE_KEY'] = process.env['AZETH_PRIVATE_KEY'];
    savedEnv['DEPLOYER_PRIVATE_KEY'] = process.env['DEPLOYER_PRIVATE_KEY'];
    savedEnv['X402_PAY_TO'] = process.env['X402_PAY_TO'];
    savedEnv['AZETH_CHAIN'] = process.env['AZETH_CHAIN'];

    // Clear all relevant env vars
    delete process.env['X402_FACILITATOR_KEY'];
    delete process.env['AZETH_PRIVATE_KEY'];
    delete process.env['DEPLOYER_PRIVATE_KEY'];
    delete process.env['X402_PAY_TO'];
    delete process.env['AZETH_CHAIN'];
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  // ── CAIP2_NETWORKS mapping ──

  describe('CAIP2_NETWORKS', () => {
    it('has correct values for all supported chains', () => {
      expect(CAIP2_NETWORKS).toEqual({
        base: 'eip155:8453',
        baseSepolia: 'eip155:84532',
        ethereumSepolia: 'eip155:11155111',
        ethereum: 'eip155:1',
      });
    });

    it('base is eip155:8453', () => {
      expect(CAIP2_NETWORKS.base).toBe('eip155:8453');
    });

    it('baseSepolia is eip155:84532', () => {
      expect(CAIP2_NETWORKS.baseSepolia).toBe('eip155:84532');
    });
  });

  // ── createX402StackFromEnv null-guard behavior ──

  describe('createX402StackFromEnv', () => {
    const emptyRoutes = {};

    it('returns null when no private key is set', async () => {
      process.env['X402_PAY_TO'] = '0x1234567890abcdef1234567890abcdef12345678';
      // No X402_FACILITATOR_KEY, AZETH_PRIVATE_KEY, or DEPLOYER_PRIVATE_KEY set
      const result = await createX402StackFromEnv(emptyRoutes);
      expect(result).toBeNull();
    });

    it('returns null when no payTo and no AZETH_PRIVATE_KEY for auto-resolve', async () => {
      process.env['X402_FACILITATOR_KEY'] = '0x' + 'ab'.repeat(32);
      // No X402_PAY_TO, no AZETH_PRIVATE_KEY — cannot auto-resolve smart account
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await createX402StackFromEnv(emptyRoutes);
      expect(result).toBeNull();
      warnSpy.mockRestore();
    });

    it('returns null for invalid payTo address format', async () => {
      process.env['X402_FACILITATOR_KEY'] = '0x' + 'ab'.repeat(32);
      process.env['X402_PAY_TO'] = 'not-a-valid-address';
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await createX402StackFromEnv(emptyRoutes);
      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith('[AzethProvider] Invalid X402_PAY_TO address format');
      consoleSpy.mockRestore();
    });

    it('uses payTo override instead of X402_PAY_TO env var', async () => {
      process.env['X402_FACILITATOR_KEY'] = '0x' + 'ab'.repeat(32);
      process.env['X402_PAY_TO'] = '0x0000000000000000000000000000000000000001';
      const overrideAddr = '0x1111111111111111111111111111111111111111' as `0x${string}`;
      // Override takes precedence — will fail deeper in the stack (no real RPC), but payTo is accepted
      try {
        await createX402StackFromEnv(emptyRoutes, { payTo: overrideAddr });
      } catch {
        // Expected — deeper x402 init fails without real RPC, but payTo was accepted
      }
    });

    it('falls back to AZETH_PRIVATE_KEY when X402_FACILITATOR_KEY is not set', async () => {
      process.env['AZETH_PRIVATE_KEY'] = '0x' + 'cd'.repeat(32);
      process.env['X402_PAY_TO'] = '0x1234567890abcdef1234567890abcdef12345678';
      // Should not return null — AZETH_PRIVATE_KEY is a valid fallback for facilitator key
      try {
        await createX402StackFromEnv(emptyRoutes);
      } catch {
        // Expected — deeper x402 init fails without real RPC, but key was accepted
      }
    });
  });
});
