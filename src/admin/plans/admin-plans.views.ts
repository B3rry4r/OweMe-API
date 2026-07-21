/** Registry AdminPlansView response DTO, verbatim. */

export interface AdminPlanView {
  planId: string;
  label: string;
  monthlyKobo: number;
  ceilingKobo: number | null;
  /** Monthly OweMe credit grant; null means fair use (enterprise). */
  creditsPerMonth: number | null;
  staffSeats: number;
  /** Zero-based position on the fixed ladder starter -> market -> business -> wholesale -> enterprise. */
  planOrder: number;
}
