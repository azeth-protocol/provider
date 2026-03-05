import { describe, it, expect } from 'vitest';
import {
  createPaymentAgreementExtension,
  PAYMENT_AGREEMENT_KEY,
  type AgreementTerms,
} from '../../src/extensions/payment-agreement.js';

const TERMS: AgreementTerms = {
  payee: '0x2222222222222222222222222222222222222222' as `0x${string}`,
  token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`,
  moduleAddress: '0x9999999999999999999999999999999999999999' as `0x${string}`,
  minAmountPerInterval: '10000',
  suggestedInterval: 86400,
};

describe('createPaymentAgreementExtension', () => {
  it('returns extension with correct key', () => {
    const ext = createPaymentAgreementExtension(TERMS);
    expect(ext.key).toBe(PAYMENT_AGREEMENT_KEY);
    expect(ext.key).toBe('payment-agreement');
  });

  it('enrichPaymentRequiredResponse returns correct structure with acceptsAgreements: true', async () => {
    const ext = createPaymentAgreementExtension(TERMS);
    const result = await ext.enrichPaymentRequiredResponse!({}, {});
    expect(result).toHaveProperty('acceptsAgreements', true);
    expect(result).toHaveProperty('terms');
  });

  it('enrichPaymentRequiredResponse includes all terms fields', async () => {
    const ext = createPaymentAgreementExtension(TERMS);
    const result = await ext.enrichPaymentRequiredResponse!({}, {});
    expect(result).toEqual({
      acceptsAgreements: true,
      terms: {
        payee: TERMS.payee,
        token: TERMS.token,
        moduleAddress: TERMS.moduleAddress,
        minAmountPerInterval: TERMS.minAmountPerInterval,
        suggestedInterval: TERMS.suggestedInterval,
      },
    });
  });

  it('different terms produce different outputs', async () => {
    const altTerms: AgreementTerms = {
      payee: '0x1111111111111111111111111111111111111111' as `0x${string}`,
      token: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as `0x${string}`,
      moduleAddress: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as `0x${string}`,
      minAmountPerInterval: '50000',
      suggestedInterval: 604800,
    };

    const ext1 = createPaymentAgreementExtension(TERMS);
    const ext2 = createPaymentAgreementExtension(altTerms);

    const result1 = await ext1.enrichPaymentRequiredResponse!({}, {});
    const result2 = await ext2.enrichPaymentRequiredResponse!({}, {});

    expect(result1).not.toEqual(result2);
    expect(result2).toEqual({
      acceptsAgreements: true,
      terms: {
        payee: altTerms.payee,
        token: altTerms.token,
        moduleAddress: altTerms.moduleAddress,
        minAmountPerInterval: altTerms.minAmountPerInterval,
        suggestedInterval: altTerms.suggestedInterval,
      },
    });
  });
});
