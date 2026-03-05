# @azeth/provider

x402 service provider tooling for [Azeth](https://azeth.ai). Gate your Hono endpoints behind x402 payments with built-in payment-agreement support, SIWx sessions, and automatic reputation feedback.

## Installation

```bash
npm install @azeth/provider
# or
pnpm add @azeth/provider
```

## Quick Start

```typescript
import { Hono } from 'hono';
import { createX402StackFromEnv } from '@azeth/provider';

const app = new Hono();

const { middleware, facilitator } = await createX402StackFromEnv({
  app,
  routes: {
    '/api/data': { price: '$0.01', resource: 'https://api.example.com/data' },
  },
});

app.use('/api/*', middleware);

app.get('/api/data', (c) => c.json({ answer: 42 }));
```

## Features

- **x402 Payment Middleware** -- Returns 402 with payment requirements, validates on-chain USDC settlement
- **Payment Agreements** -- Recurring subscriptions via on-chain `PaymentAgreementModule`
- **SIWx Sessions** -- Agreement-aware session storage for repeat customers
- **Agreement Keeper** -- Periodic execution of due payment agreements
- **Pre-Settled Payments** -- Middleware for endpoints accepting pre-settled x402 proofs
- **Local Facilitator** -- On-chain payment verification without external facilitator dependency

## API

### Stack Setup

| Export | Description |
|---|---|
| `createX402Stack(config)` | Create x402 middleware + facilitator from explicit config |
| `createX402StackFromEnv(options)` | Create from environment variables |
| `LocalFacilitatorClient` | On-chain USDC settlement verification |

### Payment Agreements

| Export | Description |
|---|---|
| `createPaymentAgreementExtension()` | x402 extension for agreement-based payments |
| `AzethSIWxStorage` | Agreement-aware SIWx session storage |
| `AgreementKeeper` | Periodic execution of due agreements |
| `findActiveAgreementForPayee()` | LRU-cached agreement lookup |

### Middleware

| Export | Description |
|---|---|
| `preSettledPaymentMiddleware` | Accept pre-settled x402 payment proofs |
| `paymentMiddlewareFromHTTPServer` | Standard x402 HTTP resource server middleware |

## License

MIT
