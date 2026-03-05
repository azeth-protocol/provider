import type { ResourceServerExtension } from '@x402/core/types';

/** Payment agreement terms advertised in the 402 response.
 *  Tells clients they can create an on-chain agreement instead of paying per-request. */
export interface AgreementTerms {
  /** Service payee address */
  payee: `0x${string}`;
  /** Payment token address (e.g., USDC) */
  token: `0x${string}`;
  /** PaymentAgreementModule contract address */
  moduleAddress: `0x${string}`;
  /** Minimum amount per interval in token smallest units */
  minAmountPerInterval: string;
  /** Suggested interval in seconds (e.g., 86400 for daily) */
  suggestedInterval: number;
}

/** Extension key used in 402 response extensions object */
export const PAYMENT_AGREEMENT_KEY = 'payment-agreement';

/** Create a custom ResourceServerExtension that adds agreement terms to the 402 response.
 *
 *  Clients see in the 402 response:
 *  ```json
 *  {
 *    "extensions": {
 *      "payment-agreement": {
 *        "acceptsAgreements": true,
 *        "terms": { "payee": "0x...", "token": "0x...", ... }
 *      }
 *    }
 *  }
 *  ```
 *
 *  This is a server-side-only extension — it adds metadata to the PaymentRequired
 *  response but does not validate incoming payment payloads. Agreement validation
 *  happens in AzethSIWxStorage.hasPaid().
 */
export function createPaymentAgreementExtension(terms: AgreementTerms): ResourceServerExtension {
  return {
    key: PAYMENT_AGREEMENT_KEY,

    /** Enrich the 402 PaymentRequired response with agreement terms */
    async enrichPaymentRequiredResponse(_declaration: unknown, _context: unknown) {
      return {
        acceptsAgreements: true,
        terms: {
          payee: terms.payee,
          token: terms.token,
          moduleAddress: terms.moduleAddress,
          minAmountPerInterval: terms.minAmountPerInterval,
          suggestedInterval: terms.suggestedInterval,
        },
      };
    },
  };
}
