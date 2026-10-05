import { EntitySchema, QueryRunner } from 'typeorm';

import { DataSource } from '../lib';
import { CustomQueryRunner } from '../lib/customQueryRunner';
import { ownershipRows } from './testData';

/**
 * Schema for the two in-memory records used by SQLite ownership
 * consumers.
 */
export const row = new EntitySchema<{ id: number; value: string }>({
  name: 'OwnershipFixture',
  columns: { id: { type: Number, primary: true }, value: { type: String } },
});

/**
 * Yield one event-loop turn so a competing operation can request
 * ownership.
 */
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Register fresh database setup and the original runner/mock cleanup
 * per scenario.
 */
export const registerSqliteOwnershipHooks = (
  onInitialize: (source: DataSource) => void,
) => {
  let source: DataSource;
  const runners: CustomQueryRunner[] = [];
  /** Create and track a runner for cleanup after the scenario. */
  const runner = () => {
    const result = source.createQueryRunner() as CustomQueryRunner;
    runners.push(result);
    return result;
  };
  beforeEach(async () => {
    source = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [row],
      synchronize: true,
    });
    await source.initialize();
    await source.getRepository(row).insert(ownershipRows);
    onInitialize(source);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const item of runners.splice(0)) {
      while (item.isTransactionActive) await item.rollbackTransaction();
      await item.release();
    }
    await source.destroy();
  });
  return runner;
};

/**
 * Successful migration fixture exercises ownership through
 * MigrationExecutor.
 */
export class OwnershipMigration1730000000000 {
  /** Create and seed the table used by the successful migration. */
  async up(query: QueryRunner) {
    await query.query(
      'CREATE TABLE migration_fixture (id integer PRIMARY KEY)',
    );
    await query.query('INSERT INTO migration_fixture VALUES (1)');
  }
  /** Remove the table when the successful migration is reverted. */
  async down(query: QueryRunner) {
    await query.query('DROP TABLE migration_fixture');
  }
}

/**
 * Retriable migration fixture exercises an after-start subscriber
 * failure.
 */
export class FailureMigration1730000000001 {
  /** Create the table used to exercise a retriable migration failure. */
  async up(query: QueryRunner) {
    await query.query('CREATE TABLE failure_migration (id integer)');
  }
  /** Remove the table when the retriable migration is reverted. */
  async down(query: QueryRunner) {
    await query.query('DROP TABLE failure_migration');
  }
}
