/**
 * Registry AdminBusinessActions response DTOs, verbatim.
 *
 * Six of the seven endpoints answer with the wave-2 read shapes
 * (AdminBusinessDetailView / AdminCreditUsageView from ../businesses/admin-businesses.views)
 * so the dashboard re-renders the same header it already binds; only the test-business
 * reset has a shape of its own.
 */

/** POST /admin/businesses/:id/reset-test response. Counts are the rows actually removed. */
export interface AdminResetTestBusinessView {
  ok: true;
  cleared: {
    debts: number;
    payments: number;
    reminders: number;
  };
}
