// Application-wide mail policy. Providers adapt protocols; they do not opt out of
// shared caching, retention or refresh rules. See docs/mail.md.
export const MAIL_POLICY = {
  refreshMs: 60 * 1000,
  manualRefreshMs: 5 * 1000,
  memoryIdleMs: 10 * 60 * 1000,
  diskIdleMs: 48 * 60 * 60 * 1000,
  listPageSize: 50,
  latestRangesPerFolder: 1,
  historyRangesPerFolder: 4,
  bodyEntries: 8,
  diskEntries: 128,
  diskBytes: 16 * 1024 * 1024,
  diskEntryBytes: 1024 * 1024,
} as const
