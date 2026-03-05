// x402 stack — core provider functionality
export {
  createX402Stack,
  createX402StackFromEnv,
  CAIP2_NETWORKS,
  LocalFacilitatorClient,
  // Re-exported x402 types
  declareSIWxExtension,
  paymentMiddlewareFromHTTPServer,
} from './stack.js';
export type {
  X402StackConfig,
  X402Stack,
  RoutesConfig,
  x402HTTPResourceServer,
} from './stack.js';

// Agreement-aware SIWx storage
export { AzethSIWxStorage } from './storage.js';
export type { AzethSIWxStorageConfig } from './storage.js';

// Agreement keeper — periodic execution of due agreements
export { AgreementKeeper } from './agreement-keeper.js';
export type { AgreementKeeperConfig } from './agreement-keeper.js';

// Agreement cache — LRU cache with stale-on-error
export { findActiveAgreementForPayee, clearAgreementCache, setAgreementCacheTtl } from './agreement-cache.js';

// Payment agreement extension
export { createPaymentAgreementExtension, PAYMENT_AGREEMENT_KEY } from './extensions/payment-agreement.js';
export type { AgreementTerms } from './extensions/payment-agreement.js';

// Pre-settled payment middleware
export { preSettledPaymentMiddleware } from './middleware/pre-settled.js';
export type { ProviderEnv } from './middleware/pre-settled.js';
