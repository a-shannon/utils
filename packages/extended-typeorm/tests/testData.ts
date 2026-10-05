/**
 * Two records distinguish the owning transaction from an unrelated
 * writer.
 */
export const ownershipRows = [
  { id: 1, value: 'target' },
  { id: 2, value: 'unrelated' },
];

/**
 * Subscriber and isolation faults used to test nested-start
 * acknowledgement.
 */
export const nestedStartFaults = ['before', 'after', 'isolation'] as const;

/** Finish operations retain the original union for shared scenario callbacks. */
type TransactionFinish = 'commit' | 'rollback';

/** Commit cases belong to the commitTransaction method group. */
export const commitFinishes: TransactionFinish[] = ['commit'];

/** Rollback cases belong to the rollbackTransaction method group. */
export const rollbackFinishes: TransactionFinish[] = ['rollback'];

/**
 * Raw transaction controls include comments, whitespace and
 * statement separators.
 */
export const rawTransactionCommands = [
  'BEGIN',
  ' /* comment */ BEGIN TRANSACTION',
  '-- comment\nCOMMIT',
  '; END',
  'ROLLBACK',
  'SAVEPOINT external',
  'RELEASE external',
];
