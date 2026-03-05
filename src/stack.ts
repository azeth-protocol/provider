import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Transport,
  type Account,
} from 'viem';
import { publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { TOKENS, AZETH_CONTRACTS, resolveViemChain, type SupportedChainName } from '@azeth/common';
import { x402Facilitator } from '@x402/core/facilitator';
import { x402ResourceServer, x402HTTPResourceServer, type FacilitatorClient, type RoutesConfig } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements, VerifyResponse, SettleResponse, SupportedResponse } from '@x402/core/types';
import { registerExactEvmScheme as registerFacilitatorEvm } from '@x402/evm/exact/facilitator';
import { registerExactEvmScheme as registerServerEvm } from '@x402/evm/exact/server';
import { toFacilitatorEvmSigner } from '@x402/evm';
import {
  siwxResourceServerExtension,
  createSIWxSettleHook,
  createSIWxRequestHook,
  declareSIWxExtension,
} from '@x402/extensions/sign-in-with-x';
import { AzethSIWxStorage, type AzethSIWxStorageConfig } from './storage.js';
import { createPaymentAgreementExtension, type AgreementTerms } from './extensions/payment-agreement.js';

/** CAIP-2 network identifiers for supported chains */
export const CAIP2_NETWORKS: Record<SupportedChainName, `eip155:${string}`> = {
  base: 'eip155:8453',
  baseSepolia: 'eip155:84532',
  ethereumSepolia: 'eip155:11155111',
  ethereum: 'eip155:1',
};

/** Configuration for the x402 stack */
export interface X402StackConfig {
  /** Chain name */
  chainName: SupportedChainName;
  /** Network in CAIP-2 format */
  network: `eip155:${string}`;
  /** Payment recipient address */
  payTo: `0x${string}`;
  /** Wallet client for gas settlement */
  walletClient: WalletClient<Transport, Chain, Account>;
  /** Public client for on-chain reads */
  publicClient: PublicClient<Transport, Chain>;
  /** Agreement terms (null = agreements disabled) */
  agreementTerms?: AgreementTerms | null;
}

/** The complete x402 V2 stack returned by createX402Stack */
export interface X402Stack {
  /** Self-hosted facilitator */
  facilitator: x402Facilitator;
  /** Resource server wrapping the facilitator */
  server: x402ResourceServer;
  /** HTTP server wrapping the resource server with routes */
  httpServer: x402HTTPResourceServer;
  /** Agreement-aware SIWx storage */
  storage: AzethSIWxStorage;
  /** Public client for on-chain reads (needed by keeper) */
  publicClient: PublicClient<Transport, Chain>;
  /** Wallet client for gas settlement (needed by keeper) */
  walletClient: WalletClient<Transport, Chain, Account>;
}

/** Wraps x402Facilitator as a FacilitatorClient for in-process use.
 *  Avoids HTTP round-trips by calling the facilitator directly. */
export class LocalFacilitatorClient implements FacilitatorClient {
  private readonly f: x402Facilitator;

  constructor(facilitator: x402Facilitator) {
    this.f = facilitator;
  }

  async verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.f.verify(paymentPayload, paymentRequirements);
  }

  async settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    return this.f.settle(paymentPayload, paymentRequirements);
  }

  async getSupported(): Promise<SupportedResponse> {
    // x402Facilitator.getSupported() returns network as plain string,
    // but FacilitatorClient expects Network (`${string}:${string}`).
    // The values are always CAIP-2 formatted, so the cast is safe.
    return this.f.getSupported() as unknown as SupportedResponse;
  }
}

/** Create the complete x402 V2 stack with self-hosted facilitator, SIWx sessions,
 *  and payment agreement support.
 *
 *  Architecture:
 *  1. Self-hosted facilitator (we control settlement, no external dependency)
 *  2. Resource server with EVM price parsing
 *  3. SIWx extension for wallet-based sessions
 *  4. Payment-agreement extension for subscription terms
 *  5. Agreement-aware SIWx storage for hybrid access
 *
 *  @param config - Stack configuration
 *  @param routes - Route configurations for protected endpoints
 *  @returns Complete x402 stack
 */
export function createX402Stack(
  config: X402StackConfig,
  routes: RoutesConfig,
): X402Stack {
  // 1. Create facilitator signer from wallet+public client
  const combinedClient = config.walletClient.extend(publicActions);
  // Cast needed: viem's verifyTypedData uses strict TypedDataParameter[] types
  // while @x402's FacilitatorEvmSigner uses simplified Record<string, unknown>.
  // Runtime behavior is identical — this is a type-level mismatch only.
  const signer = toFacilitatorEvmSigner(
    combinedClient as unknown as Parameters<typeof toFacilitatorEvmSigner>[0],
  );

  // 2. Self-hosted facilitator with EVM exact scheme
  const facilitator = new x402Facilitator();
  registerFacilitatorEvm(facilitator, {
    signer,
    networks: config.network,
    deployERC4337WithEIP6492: true,
  });

  // 3. Local facilitator client (no HTTP round-trips)
  const facilitatorClient = new LocalFacilitatorClient(facilitator);

  // 4. Resource server with EVM scheme
  const server = new x402ResourceServer(facilitatorClient);
  registerServerEvm(server);

  // 5. Register SIWx extension (wallet sessions)
  server.registerExtension(siwxResourceServerExtension);

  // 6. Register payment-agreement extension if configured
  if (config.agreementTerms) {
    server.registerExtension(createPaymentAgreementExtension(config.agreementTerms));
  }

  // 7. Agreement-aware SIWx storage
  const storageConfig: AzethSIWxStorageConfig = {
    publicClient: config.publicClient,
    servicePayee: config.payTo,
    serviceToken: config.agreementTerms?.token
      ? config.agreementTerms.token as `0x${string}`
      : undefined,
    moduleAddress: config.agreementTerms?.moduleAddress
      ? config.agreementTerms.moduleAddress as `0x${string}`
      : undefined,
    minAgreementAmount: config.agreementTerms?.minAmountPerInterval
      ? BigInt(config.agreementTerms.minAmountPerInterval)
      : undefined,
  };
  const storage = new AzethSIWxStorage(storageConfig);

  // 8. SIWx hooks: session recording + request validation
  facilitator.onAfterSettle(createSIWxSettleHook({ storage }));

  // 9. HTTP server wraps resource server + routes
  const httpServer = new x402HTTPResourceServer(server, routes);
  httpServer.onProtectedRequest(createSIWxRequestHook({
    storage,
    verifyOptions: {
      // publicClient.verifyMessage satisfies EVMMessageVerifier —
      // enables EIP-1271 (deployed smart wallets) and EIP-6492 (counterfactual)
      evmVerifier: config.publicClient.verifyMessage,
    },
  }));

  return { facilitator, server, httpServer, storage, publicClient: config.publicClient, walletClient: config.walletClient };
}

/** Create a complete x402 stack from environment variables.
 *  Returns null if required keys are missing (graceful degradation).
 *
 *  Unlike the server's version, this creates its own publicClient
 *  directly from the RPC URL — no dependency on external singletons.
 */
export function createX402StackFromEnv(
  routes: RoutesConfig,
): X402Stack | null {
  const privateKey = process.env['X402_FACILITATOR_KEY'] ?? process.env['DEPLOYER_PRIVATE_KEY'];
  const payTo = process.env['X402_PAY_TO'];

  if (!privateKey || !payTo) {
    return null;
  }

  // Validate address format
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    console.error('[AzethProvider] Invalid X402_PAY_TO address format');
    return null;
  }

  const chainName = (process.env['AZETH_CHAIN'] ?? 'baseSepolia') as SupportedChainName;
  const chain = resolveViemChain(chainName);
  const network = CAIP2_NETWORKS[chainName];
  const rpcUrl = process.env['AZETH_RPC_URL'] ?? process.env['BASE_RPC_URL'];

  let formattedKey = privateKey;
  if (!formattedKey.startsWith('0x')) {
    formattedKey = `0x${formattedKey}`;
  }

  const account = privateKeyToAccount(formattedKey as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  }) as WalletClient<Transport, Chain, Account>;

  // Create publicClient directly — no dependency on external singletons
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  }) as PublicClient<Transport, Chain>;

  // Build agreement terms from env + contract addresses
  const contracts = AZETH_CONTRACTS[chainName];
  const moduleAddress = contracts?.paymentAgreementModule;
  const usdcAddress = TOKENS[chainName].USDC;

  const agreementTerms: AgreementTerms | null = moduleAddress
    ? {
        payee: payTo as `0x${string}`,
        token: usdcAddress,
        moduleAddress: moduleAddress as `0x${string}`,
        minAmountPerInterval: process.env['X402_AGREEMENT_MIN_AMOUNT'] ?? '10000',
        suggestedInterval: 86400,
      }
    : null;

  return createX402Stack(
    {
      chainName,
      network,
      payTo: payTo as `0x${string}`,
      walletClient,
      publicClient,
      agreementTerms,
    },
    routes,
  );
}

// Re-export x402 types so consumers don't need direct @x402/* dependencies
export { declareSIWxExtension } from '@x402/extensions/sign-in-with-x';
export { paymentMiddlewareFromHTTPServer } from '@x402/hono';
export type { RoutesConfig } from '@x402/core/server';
export type { x402HTTPResourceServer } from '@x402/core/server';
