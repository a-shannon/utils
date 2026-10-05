import { SqliteQueryRunner } from 'typeorm/driver/sqlite/SqliteQueryRunner';
import { MockInstance } from 'vitest';

import { CustomQueryRunner } from '../../lib/customQueryRunner';

/**
 * Spy on the base SQLite SQL method; individual cases inject exactly
 * one fault.
 */
export const mockSqliteQuery = (): MockInstance<SqliteQueryRunner['query']> =>
  vi.spyOn(SqliteQueryRunner.prototype, 'query');

/**
 * Spy on a runner's real broadcaster; cases inject the named
 * lifecycle fault.
 */
export const mockBroadcast = (
  runner: CustomQueryRunner,
): MockInstance<CustomQueryRunner['broadcaster']['broadcast']> =>
  vi.spyOn(runner.broadcaster, 'broadcast');
