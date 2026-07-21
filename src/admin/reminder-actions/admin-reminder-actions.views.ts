/**
 * Registry AdminReminderActions declares an EMPTY dtos block: the retry response is the
 * AdminReminderView already frozen by the wave-2 reminder monitor. It is re-exported here
 * rather than redeclared so the retried row and the monitor list can never drift apart.
 */
export type { AdminReminderView } from '../reminders/admin-reminders.views';
