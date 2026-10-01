// System and synchronization settings managed by administrators
// (thesis section 3.15.2). Nodes receive them with the configuration on sync.
export const DEFAULT_SETTINGS = {
  sync_interval_seconds: 60,
  sync_max_retry_seconds: 900,
  upcoming_window_days: 7,
  overdue_grace_days: 0,
  reminder_days_before: 3,
  reminder_days_overdue: 7,
  sms_enabled: true,
  offline_login_days: 7,
  idle_logout_minutes: 15,
};

export const SETTING_LABELS = {
  sync_interval_seconds: 'Sync every (seconds) while online',
  sync_max_retry_seconds: 'Longest wait between failed sync retries (seconds)',
  upcoming_window_days: 'Show doses as "upcoming" this many days ahead',
  overdue_grace_days: 'Days after the due date before a dose is "overdue"',
  reminder_days_before: 'SMS reminder this many days before the due date',
  reminder_days_overdue: 'SMS reminder this many days after the due date',
  sms_enabled: 'Send SMS reminders to guardians',
  offline_login_days: 'Allow offline login for this many days after an online login',
  idle_logout_minutes: 'Log out after this many minutes without activity',
};

export function scheduleOptions(settings = DEFAULT_SETTINGS) {
  return { upcomingDays: settings.upcoming_window_days, graceDays: settings.overdue_grace_days };
}
