# @azeth/common

Shared types, constants, ABIs, and errors for the [Azeth](https://azeth.ai) trust infrastructure.

## Installation

```bash
npm install @azeth/common
# or
pnpm add @azeth/common
```

## What's Included

### Types

- **Account** -- `ParticipantIdentity`, `Guardrails`, `AzethContractAddresses`
- **Payments** -- `X402PaymentRequirement`, `PaymentAgreement`
- **Reputation** -- `OnChainOpinion`, `WeightedReputation`, `PaymentDelta`
- **Registry** -- `RegistryEntry`, `DiscoveryParams`, `CatalogEntry`
- **Messaging** -- `XMTPMessage`, `StructuredMessage`, `MessageRouterOptions`
- **Balances** -- `TokenBalanceUSD`, `AccountBalanceUSD`, `AggregatedBalanceResult`

### Constants

- `AZETH_CONTRACTS` -- deployed contract addresses per chain
- `ERC8004_REGISTRY` / `ERC8004_REPUTATION_REGISTRY` -- external registry addresses
- `ENTRYPOINT_V07` -- ERC-4337 EntryPoint v0.7
- `SUPPORTED_CHAINS` -- Base, Base Sepolia, Ethereum, Ethereum Sepolia
- `TOKENS` -- USDC and WETH addresses per chain
- `getBundlerUrl()`, `getPaymasterUrl()` -- chain-aware URL helpers

### ABIs

```typescript
import { AzethFactoryABI, GuardianModuleABI } from '@azeth/common/abis';
```

### Errors

```typescript
import { AzethError } from '@azeth/common';

try {
  // ...
} catch (err) {
  if (err instanceof AzethError) {
    console.error(err.code, err.message);
    // codes: BUDGET_EXCEEDED, GUARDIAN_REJECTED, INSUFFICIENT_BALANCE, ...
  }
}
```

### Validation Utilities

```typescript
import { validateAddress, validateChainName, isValidUrl } from '@azeth/common';

validateAddress('0x...');      // throws AzethError on invalid
validateChainName('base');     // resolves aliases like 'base-sepolia' -> 'baseSepolia'
```

## License

MIT
