export type ReviewState = 'FETCHED' | 'AI_PROCESSING' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';

export function assertHumanApproval(current: ReviewState, actorId?: string): void {
  if (current !== 'PENDING_REVIEW') throw new Error('IMPORT_NOT_PENDING_REVIEW');
  if (!actorId) throw new Error('HUMAN_APPROVAL_REQUIRED');
}

export function calculateNetProfit(input: {
  totalRevenue: number;
  purchaseCost: number;
  cargoCost: number;
  paymentFee: number;
  deliveryCost: number;
  otherExpenses: number;
  refundAmount: number;
}): number {
  return input.totalRevenue - input.purchaseCost - input.cargoCost - input.paymentFee
    - input.deliveryCost - input.otherExpenses - input.refundAmount;
}

export function slugifyProduct(value: string): string {
  const slug = value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9\u0400-\u04ff]+/g, '-').replace(/^-|-$/g, '');
  return slug || 'product';
}
