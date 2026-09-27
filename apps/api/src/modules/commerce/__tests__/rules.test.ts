import { describe, expect, it } from 'vitest';
import { assertHumanApproval, calculateNetProfit } from '../rules';

describe('AVERON commerce invariants', () => {
  it('forbids publication without a human actor', () => {
    expect(() => assertHumanApproval('PENDING_REVIEW')).toThrow('HUMAN_APPROVAL_REQUIRED');
  });

  it('forbids approving an import outside pending review', () => {
    expect(() => assertHumanApproval('APPROVED', 'admin-id')).toThrow('IMPORT_NOT_PENDING_REVIEW');
  });

  it('calculates net profit from actual costs and refunds', () => {
    expect(calculateNetProfit({ totalRevenue: 300000, purchaseCost: 150000, cargoCost: 30000, paymentFee: 5000, deliveryCost: 10000, otherExpenses: 5000, refundAmount: 0 })).toBe(100000);
  });
});
