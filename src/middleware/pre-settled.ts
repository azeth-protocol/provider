import type { Context, Env, Next } from 'hono';
import { createPublicClient, http, parseAbiItem, type PublicClient, type Chain, type Transport } from 'viem';
import { resolveViemChain, type SupportedChainName } from '@azeth/common';

/** Minimal Hono env for pre-settled payment middleware.
 *  Consumer apps can extend this with their own variables. */
export interface ProviderEnv extends Env {
  Variables: {
    paymentFrom: `0x${string}`;
    paymentAmount: bigint;
    paymentTxHash: `0x${string}`;
  };
}

/** USDC Transfer(address,address,uint256) event topic */
const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/** Track consumed tx hashes to prevent replay (one payment = one access) */
const usedTxHashes = new Set<string>();
const MAX_USED_TX_HASHES = 50_000;

/** Pre-settled payment verification middleware.
 *
 *  Checks for X-Payment-Tx header. If present, verifies the transaction on-chain
 *  by decoding USDC Transfer event logs and confirming the payment meets requirements.
 *
 *  When valid: sets context variables (paymentFrom, paymentAmount, paymentTxHash)
 *  and calls next() — downstream x402 middleware should be skipped.
 *
 *  When invalid: falls through to let x402 middleware handle normally.
 */
export function preSettledPaymentMiddleware(config: {
  payTo: `0x${string}`;
  usdcAddress: `0x${string}`;
  priceAtomicAmount: bigint;
  rpcUrl?: string;
  chainName?: SupportedChainName;
}) {
  const chain: Chain = resolveViemChain(config.chainName ?? 'baseSepolia');
  const publicClient: PublicClient<Transport, Chain> = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  });

  return async (c: Context<ProviderEnv>, next: Next) => {
    const txHashHeader = c.req.header('X-Payment-Tx');
    if (!txHashHeader || !/^0x[0-9a-fA-F]{64}$/.test(txHashHeader)) {
      return next();
    }

    const txHash = txHashHeader as `0x${string}`;

    // Reject already-consumed tx hashes before making RPC call
    if (usedTxHashes.has(txHash)) {
      return next(); // Fall through to x402
    }

    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });

      if (receipt.status !== 'success') {
        return next(); // Transaction failed, fall through to x402
      }

      // Find USDC Transfer event matching requirements
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== config.usdcAddress.toLowerCase()) continue;
        if (log.topics.length < 3) continue;

        // topics[0] = event sig, topics[1] = from, topics[2] = to
        const eventSig = log.topics[0];
        if (eventSig !== '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') continue;

        const toAddress = `0x${log.topics[2]!.slice(26)}` as `0x${string}`;
        if (toAddress.toLowerCase() !== config.payTo.toLowerCase()) continue;

        // Decode value from log data
        const value = BigInt(log.data);
        if (value < config.priceAtomicAmount) continue;

        // Valid pre-settled payment found — extract `from` from the on-chain log,
        // NOT the client-controlled header (which could be spoofed).
        const logFrom = `0x${log.topics[1]!.slice(26)}` as `0x${string}`;
        c.set('paymentFrom', logFrom);
        c.set('paymentAmount', value);
        c.set('paymentTxHash', txHash);

        // Mark tx hash as consumed — prevents replay
        usedTxHashes.add(txHash);
        if (usedTxHashes.size > MAX_USED_TX_HASHES) {
          const oldest = usedTxHashes.values().next().value;
          if (oldest !== undefined) usedTxHashes.delete(oldest);
        }

        // Set a flag for downstream to know payment is pre-settled
        (c as unknown as Record<string, unknown>)['preSettledVerified'] = true;
        return next();
      }
    } catch {
      // RPC error or tx not found — fall through to x402
    }

    return next();
  };
}
