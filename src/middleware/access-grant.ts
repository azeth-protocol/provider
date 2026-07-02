import type { MiddlewareHandler } from 'hono';
import { parseSIWxHeader, SIGN_IN_WITH_X } from '@x402/extensions/sign-in-with-x';
import type { AzethSIWxStorage } from '../storage.js';

/** Response header discriminating how access was granted without fresh settlement (F4).
 *  Values: 'session' (prior payment record) | 'agreement' (active on-chain agreement). */
export const ACCESS_GRANT_HEADER = 'X-Access-Grant';

/** Access-grant discriminator middleware (F4).
 *
 *  Emits `X-Access-Grant: session | agreement` on responses where access was
 *  granted via SIWx WITHOUT fresh settlement, so clients can report the correct
 *  paymentMethod. Emitted only when ALL hold (checked after `await next()`):
 *  - the request carried a SIGN-IN-WITH-X header,
 *  - the final response status is < 400 (never on 402/4xx/5xx),
 *  - the response has NO PAYMENT-RESPONSE header (no fresh facilitator settlement),
 *  - the `preSettledVerified` context flag is NOT set (no fresh pre-settled settlement).
 *
 *  The value comes from {@link AzethSIWxStorage.getGrantKind}, keyed per
 *  resource+address — falls back to 'session' when unknown (e.g., auth-only routes).
 *
 *  This cannot go through @x402 hooks: the grant path returns zero headers
 *  (a grant response is byte-identical to a free one), so the discriminator
 *  must be added by a Hono post-middleware. Register it BEFORE the pre-settled
 *  and x402 middlewares so its post-phase runs after the response is final.
 *
 *  Backward compatible in both directions: old clients ignore the extra header;
 *  the middleware never alters status or body, and any internal error (e.g., a
 *  malformed SIWx header) leaves the response untouched.
 *
 *  @param storage - The agreement-aware SIWx storage backing the x402 stack
 *  @returns Hono middleware that annotates grant responses
 */
export function accessGrantHeaderMiddleware(storage: AzethSIWxStorage): MiddlewareHandler {
  return async (c, next) => {
    await next();

    try {
      // Request must have presented a SIWx identity (header lookup is case-insensitive)
      const siwxHeader = c.req.header(SIGN_IN_WITH_X);
      if (!siwxHeader) return;

      // Never on 402/4xx/5xx — access was not granted
      if (c.res.status >= 400) return;

      // Fresh facilitator settlement happened — this was a paid response, not a grant
      if (c.res.headers.get('PAYMENT-RESPONSE') !== null) return;

      // Fresh pre-settled settlement happened (X-Payment-Tx verified this request)
      if ((c as unknown as Record<string, unknown>)['preSettledVerified']) return;

      const payload = parseSIWxHeader(siwxHeader);
      const kind = storage.getGrantKind(c.req.path, payload.address) ?? 'session';
      c.res.headers.set(ACCESS_GRANT_HEADER, kind);
    } catch {
      // Best-effort advisory header — a malformed SIWx header or any other
      // error must never alter the response.
    }
  };
}
