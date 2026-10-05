import { SqliteQueryRunner } from 'typeorm/driver/sqlite/SqliteQueryRunner';

import { DataSource } from '../lib';
import { CustomQueryRunner } from '../lib/customQueryRunner';
import { createAndInitializeDataSource } from './customQueryRunnerTestUtils';
import {
  mockBroadcast,
  mockSqliteQuery,
} from './mocked/sqliteQueryRunner.mock';
import {
  commitFinishes,
  nestedStartFaults,
  rawTransactionCommands,
  rollbackFinishes,
} from './testData';
import {
  FailureMigration1730000000001,
  OwnershipMigration1730000000000,
  registerSqliteOwnershipHooks,
  row,
  tick,
} from './testUtils';

describe('CustomQueryRunner', () => {
  describe('query', () => {
    describe('SQLite ownership', () => {
      let source: DataSource;
      registerSqliteOwnershipHooks((initialized) => {
        source = initialized;
      });

      /**
       * @target CustomQueryRunner.query allows awaited same-runner
       * subscriber queries while foreign writers wait
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * @scenario
       * - Pause an outer query in a subscriber after an awaited inner
       * query and attempted transaction start. Start a foreign repository
       * update, inspect its pending state, release the subscriber and
       * await both operations.
       * @expected
       * - The inner result is returned; a start during the pending query
       * rejects; the foreign writer waits and its update survives.
       */
      it('allows awaited same-runner subscriber queries while foreign writers wait', async () => {
        let entered!: () => void;
        let release!: () => void;
        const inside = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        source.subscribers.push({
          beforeQuery: async (event) => {
            if (event.query !== 'SELECT 11 AS outer_value') return;
            expect(
              await event.queryRunner.query('SELECT 22 AS inner_value'),
            ).toEqual([{ inner_value: 22 }]);
            await expect(event.queryRunner.startTransaction()).rejects.toThrow(
              'already pending',
            );
            entered();
            await barrier;
          },
        });
        const outer = source.query('SELECT 11 AS outer_value');
        await inside;
        let written = false;
        const foreign = source
          .getRepository(row)
          .update({ id: 2 }, { value: 'foreign' })
          .then(() => {
            written = true;
          });
        await tick();
        expect(written).toEqual(false);
        release();
        expect(await outer).toEqual([{ outer_value: 11 }]);
        await foreign;
        expect(
          (await source.getRepository(row).findOneByOrFail({ id: 2 })).value,
        ).toEqual('foreign');
      });

      /**
       * @target CustomQueryRunner.query releases ordinary ownership when
       * an awaited subscriber query fails
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * @scenario
       * - Make the outer query subscriber await a query against an absent
       * inner table. Await the failure, then issue an ordinary query.
       * @expected
       * - The inner failure propagates and ordinary ownership is released.
       */
      it('releases ordinary ownership when an awaited subscriber query fails', async () => {
        source.subscribers.push({
          beforeQuery: async (event) => {
            if (event.query === 'SELECT 11 AS outer_value')
              await event.queryRunner.query(
                'SELECT * FROM missing_inner_table',
              );
          },
        });
        await expect(source.query('SELECT 11 AS outer_value')).rejects.toThrow(
          'missing_inner_table',
        );
        await expect(source.query('SELECT 1')).resolves.toEqual([{ '1': 1 }]);
      });

      /**
       * @target CustomQueryRunner.query rejects raw transaction command %s
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * @scenario
       * - Issue each raw transaction command, including whitespace,
       * comment and separator variants, then issue an ordinary query.
       * @expected
       * - Every raw transaction command rejects and the ordinary query
       * succeeds.
       */
      it.each(rawTransactionCommands)(
        'rejects raw transaction command %s',
        async (sql) => {
          await expect(source.query(sql)).rejects.toThrow('transaction API');
          await expect(source.query('SELECT 1')).resolves.toEqual([{ '1': 1 }]);
        },
      );
    });
  });

  describe('startTransaction', () => {
    describe('SQLite ownership', () => {
      let source: DataSource;
      const runner = registerSqliteOwnershipHooks((initialized) => {
        source = initialized;
      });

      /**
       * @target CustomQueryRunner.startTransaction rejects a concurrent
       * same-runner start before the first owns the connection
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * @scenario
       * - Hold a transaction, request another runner start, and attempt a
       * second start, query and release on that waiting runner. Release
       * the holder, complete the waiting start and roll it back.
       * @expected
       * - Overlapping operations reject; both runners recover and an
       * ordinary query succeeds.
       */
      it('rejects a concurrent same-runner start before the first owns the connection', async () => {
        const holder = runner();
        const waiting = runner();
        await holder.startTransaction();
        const start = waiting.startTransaction();
        await expect(waiting.startTransaction()).rejects.toThrow(
          'already pending',
        );
        await expect(waiting.query('SELECT 1')).rejects.toThrow(
          'already pending',
        );
        await expect(waiting.release()).rejects.toThrow('Finish');
        await holder.rollbackTransaction();
        await start;
        await waiting.rollbackTransaction();
        await expect(source.query('SELECT 1')).resolves.toEqual([{ '1': 1 }]);
      });

      /**
       * @target CustomQueryRunner.startTransaction serializes separate
       * concurrent transactions
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * @scenario
       * - Run five concurrent manager transactions. Count active callbacks
       * before and after yielding; update the same row in each and read
       * the final value.
       * @expected
       * - Only one callback owns the connection at a time and the last
       * transaction value persists.
       */
      it('serializes separate concurrent transactions', async () => {
        let active = 0;
        await Promise.all(
          Array.from({ length: 5 }, (_, index) =>
            source.transaction(async (manager) => {
              expect(active++).toEqual(0);
              await manager
                .getRepository(row)
                .update({ id: 1 }, { value: String(index) });
              await tick();
              expect(--active).toEqual(0);
            }),
          ),
        );
        expect(
          (await source.getRepository(row).findOneByOrFail({ id: 1 })).value,
        ).toEqual('4');
      });

      /**
       * @target CustomQueryRunner.startTransaction supports save and
       * nested manager transactions
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * @scenario
       * - Save an outer row and another row in a nested manager
       * transaction, then read both records. Follow with an ordinary
       * repository save.
       * @expected
       * - Nested and ordinary saves retain their exact values.
       */
      it('supports save and nested manager transactions', async () => {
        await source.transaction(async (manager) => {
          await manager.save(row, { id: 1, value: 'saved' });
          await manager.transaction(async (nested) => {
            await nested.save(row, { id: 2, value: 'nested' });
          });
        });
        expect(
          await source.getRepository(row).find({ order: { id: 'ASC' } }),
        ).toEqual([
          { id: 1, value: 'saved' },
          { id: 2, value: 'nested' },
        ]);
        await source.getRepository(row).save({ id: 1, value: 'ordinary-save' });
        expect(
          (await source.getRepository(row).findOneByOrFail({ id: 1 })).value,
        ).toEqual('ordinary-save');
      });

      /**
       * @target CustomQueryRunner.startTransaction releases ownership when
       * BEGIN fails before opening a transaction
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * - Mocked SqliteQueryRunner.query injects the named SQL failure.
       * @scenario
       * - Make the base SQLite query method reject BEGIN. Attempt a start,
       * inspect its active state, restore the method, update an unrelated
       * row and start and roll back again.
       * @expected
       * - The start failure leaves no active ownership and subsequent
       * operations succeed.
       */
      it('releases ownership when BEGIN fails before opening a transaction', async () => {
        const owner = runner();
        const original = SqliteQueryRunner.prototype.query;
        const query = mockSqliteQuery().mockImplementation(function (
          this: SqliteQueryRunner,
          sql,
          parameters,
          structured,
        ) {
          if (sql === 'BEGIN TRANSACTION')
            return Promise.reject(new Error('fixture BEGIN failure'));
          return original.call(this, sql, parameters, structured);
        });
        await expect(owner.startTransaction()).rejects.toThrow('BEGIN failure');
        expect(owner.isTransactionActive).toEqual(false);
        query.mockRestore();
        await source
          .getRepository(row)
          .update({ id: 2 }, { value: 'after-failure' });
        await owner.startTransaction();
        await owner.rollbackTransaction();
      });

      /**
       * @target CustomQueryRunner.startTransaction releases ownership
       * after invalid isolation or an ordinary SQL error
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * @scenario
       * - Request unsupported isolation and query an absent table. Perform
       * an ordinary update and read its record.
       * @expected
       * - Both invalid operations reject and the later update persists.
       */
      it('releases ownership after invalid isolation or an ordinary SQL error', async () => {
        const owner = runner();
        await expect(owner.startTransaction('READ COMMITTED')).rejects.toThrow(
          'SQLite only',
        );
        await expect(
          source.query('SELECT * FROM nonexistent_table'),
        ).rejects.toThrow();
        await source
          .getRepository(row)
          .update({ id: 2 }, { value: 'recovered' });
        expect(
          (await source.getRepository(row).findOneByOrFail({ id: 2 })).value,
        ).toEqual('recovered');
      });

      /**
       * @target CustomQueryRunner.startTransaction releases ownership
       * after a before-start subscriber fails
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * - Mocked Broadcaster.broadcast injects the named lifecycle
       * failure.
       * @scenario
       * - Make the runner broadcaster reject before a transaction starts,
       * attempt a start, restore the broadcaster and inspect an ordinary
       * query.
       * @expected
       * - The start rejects without active ownership and an ordinary query
       * succeeds.
       */
      it('releases ownership after a before-start subscriber fails', async () => {
        const owner = runner();
        const broadcast = mockBroadcast(owner).mockRejectedValue(
          new Error('before start failure'),
        );
        await expect(owner.startTransaction()).rejects.toThrow(
          'before start failure',
        );
        broadcast.mockRestore();
        expect(owner.isTransactionActive).toEqual(false);
        await expect(source.query('SELECT 1')).resolves.toEqual([{ '1': 1 }]);
      });

      /**
       * @target CustomQueryRunner.startTransaction rolls back its own
       * BEGIN when an after-start subscriber fails
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * - Mocked Broadcaster.broadcast injects the named lifecycle
       * failure.
       * @scenario
       * - Make the broadcaster throw after the initial transaction starts.
       * Attempt the start, inspect its state, restore the broadcaster and
       * issue an ordinary query.
       * @expected
       * - The opened initial transaction is rolled back and ownership is
       * released.
       */
      it('rolls back its own BEGIN when an after-start subscriber fails', async () => {
        const owner = runner();
        const broadcast = mockBroadcast(owner).mockImplementation(
          async (
            ...[event]: Parameters<typeof owner.broadcaster.broadcast>
          ) => {
            if (event === 'AfterTransactionStart')
              throw new Error('after start failure');
          },
        );
        await expect(owner.startTransaction()).rejects.toThrow(
          'after start failure',
        );
        expect(owner.isTransactionActive).toEqual(false);
        broadcast.mockRestore();
        await expect(source.query('SELECT 1')).resolves.toEqual([{ '1': 1 }]);
      });

      /**
       * @target CustomQueryRunner.startTransaction acknowledges only its
       * new savepoint on a nested after-start failure
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * - Mocked Broadcaster.broadcast injects the named lifecycle
       * failure.
       * @scenario
       * - Write in an outer transaction and make the broadcaster throw
       * after a nested start. Inspect active state, restore the
       * broadcaster, roll back the nested layer, read the outer value and
       * commit it.
       * @expected
       * - Recovery removes only the new savepoint and the outer value can
       * still commit.
       */
      it('acknowledges only its new savepoint on a nested after-start failure', async () => {
        const owner = runner();
        await owner.startTransaction();
        await owner.manager
          .getRepository(row)
          .update({ id: 1 }, { value: 'outer' });
        const broadcast = mockBroadcast(owner).mockImplementation(
          async (
            ...[event]: Parameters<typeof owner.broadcaster.broadcast>
          ) => {
            if (event === 'AfterTransactionStart')
              throw new Error('nested start failure');
          },
        );
        await expect(owner.startTransaction()).rejects.toThrow(
          'nested start failure',
        );
        expect(owner.isTransactionActive).toEqual(true);
        broadcast.mockRestore();
        await owner.rollbackTransaction();
        expect(
          (await owner.manager.getRepository(row).findOneByOrFail({ id: 1 }))
            .value,
        ).toEqual('outer');
        await owner.commitTransaction();
        expect(
          (await source.getRepository(row).findOneByOrFail({ id: 1 })).value,
        ).toEqual('outer');
      });

      /**
       * @target CustomQueryRunner.startTransaction preserves the outer
       * manager transaction after nested %s start failure
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * - Mocked Broadcaster.broadcast injects the named lifecycle
       * failure.
       * @scenario
       * - For each before, after or isolation fault, write an outer
       * manager value and fail its nested start. Inspect the unused nested
       * callback, active ownership and outer record, then allow the outer
       * manager transaction to finish.
       * @expected
       * - The nested callback never runs and the outer value survives both
       * in-transaction and ordinary reads.
       */
      it.each(nestedStartFaults)(
        'preserves the outer manager transaction after nested %s start failure',
        async (fault) => {
          await source.transaction(async (manager) => {
            await manager
              .getRepository(row)
              .update({ id: 1 }, { value: 'outer-survives' });
            const owned = manager.queryRunner as CustomQueryRunner;
            const broadcast = mockBroadcast(owned).mockImplementation(
              async (
                ...[event]: Parameters<typeof owned.broadcaster.broadcast>
              ) => {
                if (
                  (fault === 'before' && event === 'BeforeTransactionStart') ||
                  (fault === 'after' && event === 'AfterTransactionStart')
                )
                  throw new Error('nested subscriber failed');
                if (event === 'BeforeTransactionRollback')
                  expect(await owned.manager.query('SELECT 1')).toEqual([
                    { '1': 1 },
                  ]);
              },
            );
            const action = vi.fn();
            await expect(
              fault === 'isolation'
                ? manager.transaction('READ COMMITTED', action)
                : manager.transaction(action),
            ).rejects.toThrow();
            expect(action).not.toHaveBeenCalled();
            expect(owned.isTransactionActive).toEqual(true);
            broadcast.mockRestore();
            expect(
              (await manager.getRepository(row).findOneByOrFail({ id: 1 }))
                .value,
            ).toEqual('outer-survives');
          });
          expect(
            (await source.getRepository(row).findOneByOrFail({ id: 1 })).value,
          ).toEqual('outer-survives');
        },
      );

      /**
       * @target CustomQueryRunner.startTransaction requires direct callers
       * to acknowledge a failed nested start before continuing
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * @scenario
       * - Write in an outer transaction and reject an unsupported nested
       * isolation request. Attempt query, commit and another start before
       * acknowledgement; then roll back the failed layer and inspect the
       * outer value before rolling back the outer transaction.
       * @expected
       * - Operations refuse until acknowledgement; the first rollback
       * preserves the outer layer and the second restores its original
       * value.
       */
      it('requires direct callers to acknowledge a failed nested start before continuing', async () => {
        const owner = runner();
        await owner.startTransaction();
        await owner.manager
          .getRepository(row)
          .update({ id: 1 }, { value: 'outer' });
        await expect(owner.startTransaction('READ COMMITTED')).rejects.toThrow(
          'SQLite only',
        );
        await expect(owner.query('SELECT 1')).rejects.toThrow('Roll back');
        await expect(owner.commitTransaction()).rejects.toThrow('Roll back');
        await expect(owner.startTransaction()).rejects.toThrow('Roll back');
        await owner.rollbackTransaction();
        expect(owner.isTransactionActive).toEqual(true);
        expect(
          (await owner.manager.getRepository(row).findOneByOrFail({ id: 1 }))
            .value,
        ).toEqual('outer');
        await owner.rollbackTransaction();
        expect(owner.isTransactionActive).toEqual(false);
        expect(
          (await source.getRepository(row).findOneByOrFail({ id: 1 })).value,
        ).toEqual('target');
      });

      /**
       * @target CustomQueryRunner.startTransaction retains ownership if
       * rollback recovery after a failed start also fails
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * - Mocked SqliteQueryRunner.query injects the named SQL failure.
       * - Mocked Broadcaster.broadcast injects the named lifecycle
       * failure.
       * @scenario
       * - Fail the after-start broadcaster and the base rollback query
       * together. Inspect the aggregate failure, active state and release
       * refusal. Restore both mocks, explicitly roll back and issue an
       * ordinary query.
       * @expected
       * - Combined start and cleanup failures retain ownership until
       * explicit successful recovery.
       */
      it('retains ownership if rollback recovery after a failed start also fails', async () => {
        const owner = runner();
        const broadcast = mockBroadcast(owner).mockImplementation(
          async (
            ...[event]: Parameters<typeof owner.broadcaster.broadcast>
          ) => {
            if (event === 'AfterTransactionStart')
              throw new Error('start callback failure');
          },
        );
        const original = SqliteQueryRunner.prototype.query;
        const query = mockSqliteQuery().mockImplementation(function (
          this: SqliteQueryRunner,
          sql,
          parameters,
          structured,
        ) {
          if (sql === 'ROLLBACK')
            return Promise.reject(new Error('cleanup failure'));
          return original.call(this, sql, parameters, structured);
        });
        await expect(owner.startTransaction()).rejects.toBeInstanceOf(
          AggregateError,
        );
        expect(owner.isTransactionActive).toEqual(true);
        await expect(owner.release()).rejects.toThrow('Finish');
        query.mockRestore();
        broadcast.mockRestore();
        await owner.rollbackTransaction();
        await expect(source.query('SELECT 1')).resolves.toEqual([{ '1': 1 }]);
      });

      /**
       * @target CustomQueryRunner.startTransaction supports migrations and
       * clean datasource lifecycle
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * @scenario
       * - Initialize a datasource with an automatic migration, read its
       * inserted row, undo the migration and query its removed table.
       * Destroy the datasource in finally.
       * @expected
       * - Migration and undo preserve transaction lifecycle; the removed
       * table rejects access.
       */
      it('supports migrations and clean datasource lifecycle', async () => {
        const migrationSource = new DataSource({
          type: 'sqlite',
          database: ':memory:',
          migrations: [OwnershipMigration1730000000000],
          migrationsRun: true,
        });
        await migrationSource.initialize();
        try {
          expect(
            await migrationSource.query('SELECT * FROM migration_fixture'),
          ).toEqual([{ id: 1 }]);
          await migrationSource.undoLastMigration();
          await expect(
            migrationSource.query('SELECT * FROM migration_fixture'),
          ).rejects.toThrow();
        } finally {
          await migrationSource.destroy();
        }
      });

      /**
       * @target CustomQueryRunner.startTransaction recovers a migration
       * whose after-start subscriber throws
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * @scenario
       * - Initialize a migration datasource, install an after-start
       * subscriber failure and run its migration. Query ordinarily after
       * the failure, remove the subscriber, rerun the migration and
       * inspect its table. Destroy the datasource in finally.
       * @expected
       * - A failed migration start releases ownership and the same
       * migration can subsequently run.
       */
      it('recovers a migration whose after-start subscriber throws', async () => {
        const migrationSource = new DataSource({
          type: 'sqlite',
          database: ':memory:',
          migrations: [FailureMigration1730000000001],
        });
        await migrationSource.initialize();
        migrationSource.subscribers.push({
          afterTransactionStart: () => {
            throw new Error('migration start failure');
          },
        });
        try {
          await expect(migrationSource.runMigrations()).rejects.toThrow(
            'migration start failure',
          );
          await expect(migrationSource.query('SELECT 1')).resolves.toEqual([
            { '1': 1 },
          ]);
          migrationSource.subscribers.length = 0;
          await migrationSource.runMigrations();
          await expect(
            migrationSource.query('SELECT * FROM failure_migration'),
          ).resolves.toEqual([]);
        } finally {
          await migrationSource.destroy();
        }
      });
    });
  });

  describe('commitTransaction', () => {
    /**
     * @target CustomQueryRunner.commitTransaction should throw Error
     * when no transaction started
     * @dependencies
     * - Real in-memory SQLite datasource and ownership-aware runner.
     * @scenario
     * - create a datasource
     * - create a query runner and connect to it
     * - call commitTransaction on it
     * @expected
     * - throw an error
     */
    it('should throw Error when no transaction started', async () => {
      const dataSource = await createAndInitializeDataSource();
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await expect(() => queryRunner.commitTransaction()).rejects.toThrow();
    });
    describe('SQLite ownership', () => {
      let source: DataSource;
      const runner = registerSqliteOwnershipHooks((initialized) => {
        source = initialized;
      });

      /**
       * @target CustomQueryRunner.commitTransaction blocks foreign
       * ordinary updates until outer %s, then preserves their result
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * @scenario
       * - For each finish operation, update one row in the owning
       * transaction and start an ordinary update to another row. Verify
       * that update waits, finish the owner and read both rows.
       * @expected
       * - The foreign update survives; the owner row reflects the selected
       * commit or rollback.
       */
      it.each(commitFinishes)(
        'blocks foreign ordinary updates until outer %s, then preserves their result',
        async (finish) => {
          const owner = runner();
          await owner.startTransaction();
          await owner.manager
            .getRepository(row)
            .update({ id: 1 }, { value: 'uncommitted' });
          let done = false;
          const foreign = source
            .getRepository(row)
            .update({ id: 2 }, { value: 'independent-winner' })
            .then(() => {
              done = true;
            });
          await tick();
          expect(done).toEqual(false);
          if (finish === 'commit') await owner.commitTransaction();
          else await owner.rollbackTransaction();
          await foreign;
          expect(
            (await source.getRepository(row).findOneByOrFail({ id: 2 })).value,
          ).toEqual('independent-winner');
          expect(
            (await source.getRepository(row).findOneByOrFail({ id: 1 })).value,
          ).toEqual(finish === 'commit' ? 'uncommitted' : 'target');
        },
      );

      /**
       * @target CustomQueryRunner.commitTransaction blocks foreign reads
       * from observing uncommitted data before %s
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * @scenario
       * - For each finish operation, write inside a transaction and start
       * an ordinary read. Verify the read is pending, finish the
       * transaction and inspect the read result.
       * @expected
       * - The ordinary read waits and returns only the committed or
       * rolled-back value.
       */
      it.each(commitFinishes)(
        'blocks foreign reads from observing uncommitted data before %s',
        async (finish) => {
          const owner = runner();
          await owner.startTransaction();
          await owner.manager
            .getRepository(row)
            .update({ id: 1 }, { value: 'uncommitted' });
          let done = false;
          const read = source
            .getRepository(row)
            .findOneByOrFail({ id: 1 })
            .then((value) => {
              done = true;
              return value;
            });
          await tick();
          expect(done).toEqual(false);
          if (finish === 'commit') await owner.commitTransaction();
          else await owner.rollbackTransaction();
          expect((await read).value).toEqual(
            finish === 'commit' ? 'uncommitted' : 'target',
          );
        },
      );

      /**
       * @target CustomQueryRunner.commitTransaction keeps ownership
       * through nested %s until outer rollback
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * @scenario
       * - For each finish operation, write at outer and nested depths and
       * start a foreign update. Finish the nested layer, inspect its value
       * and pending foreign update, then roll back the outer layer.
       * @expected
       * - Nested completion retains ownership; outer rollback restores its
       * row and the foreign update then succeeds.
       */
      it.each(commitFinishes)(
        'keeps ownership through nested %s until outer rollback',
        async (finish) => {
          const owner = runner();
          await owner.startTransaction();
          await owner.manager
            .getRepository(row)
            .update({ id: 1 }, { value: 'outer' });
          await owner.startTransaction();
          await owner.manager
            .getRepository(row)
            .update({ id: 1 }, { value: 'inner' });
          let done = false;
          const foreign = source
            .getRepository(row)
            .update({ id: 2 }, { value: 'foreign' })
            .then(() => {
              done = true;
            });
          if (finish === 'commit') await owner.commitTransaction();
          else await owner.rollbackTransaction();
          expect(owner.isTransactionActive).toEqual(true);
          expect(
            (await owner.manager.getRepository(row).findOneByOrFail({ id: 1 }))
              .value,
          ).toEqual(finish === 'commit' ? 'inner' : 'outer');
          await tick();
          expect(done).toEqual(false);
          await owner.rollbackTransaction();
          await foreign;
          expect(
            (await source.getRepository(row).findOneByOrFail({ id: 1 })).value,
          ).toEqual('target');
          expect(
            (await source.getRepository(row).findOneByOrFail({ id: 2 })).value,
          ).toEqual('foreign');
        },
      );

      /**
       * @target CustomQueryRunner.commitTransaction retains ownership on
       * failed %s until explicit recovery
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * - Mocked SqliteQueryRunner.query injects the named SQL failure.
       * @scenario
       * - For each finish operation, write inside the owner and make the
       * base query method reject that finish. Verify active state and
       * release refusal; start a foreign update and verify it waits.
       * Restore the query method and explicitly roll back the owner.
       * @expected
       * - Failed completion retains ownership; explicit recovery restores
       * the owner row and allows the waiting foreign update.
       */
      it.each(commitFinishes)(
        'retains ownership on failed %s until explicit recovery',
        async (operation) => {
          const owner = runner();
          await owner.startTransaction();
          await owner.manager
            .getRepository(row)
            .update({ id: 1 }, { value: 'uncommitted' });
          const original = SqliteQueryRunner.prototype.query;
          const query = mockSqliteQuery().mockImplementation(function (
            this: SqliteQueryRunner,
            sql,
            parameters,
            structured,
          ) {
            if (sql === (operation === 'commit' ? 'COMMIT' : 'ROLLBACK'))
              return Promise.reject(new Error('fixture finish failure'));
            return original.call(this, sql, parameters, structured);
          });
          await expect(
            operation === 'commit'
              ? owner.commitTransaction()
              : owner.rollbackTransaction(),
          ).rejects.toThrow('finish failure');
          expect(owner.isTransactionActive).toEqual(true);
          await expect(owner.release()).rejects.toThrow('Finish');
          let done = false;
          const foreign = source
            .getRepository(row)
            .update({ id: 2 }, { value: 'winner' })
            .then(() => {
              done = true;
            });
          await tick();
          expect(done).toEqual(false);
          query.mockRestore();
          await owner.rollbackTransaction();
          await foreign;
          expect(
            (await source.getRepository(row).findOneByOrFail({ id: 1 })).value,
          ).toEqual('target');
          expect(
            (await source.getRepository(row).findOneByOrFail({ id: 2 })).value,
          ).toEqual('winner');
        },
      );

      /**
       * @target CustomQueryRunner.commitTransaction does not permit raw
       * transaction control from lifecycle callbacks
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * - Mocked Broadcaster.broadcast injects the named lifecycle
       * failure.
       * @scenario
       * - Start a transaction and make its before-commit broadcast issue a
       * raw rollback query. Await commit refusal, inspect the active
       * state, restore the broadcast and roll back through the API.
       * @expected
       * - Lifecycle callbacks cannot issue raw transaction control; API
       * recovery releases ownership.
       */
      it('does not permit raw transaction control from lifecycle callbacks', async () => {
        const owner = runner();
        await owner.startTransaction();
        const broadcast = mockBroadcast(owner).mockImplementation(
          async (
            ...[event]: Parameters<typeof owner.broadcaster.broadcast>
          ) => {
            if (event === 'BeforeTransactionCommit')
              await owner.query('ROLLBACK');
          },
        );
        await expect(owner.commitTransaction()).rejects.toThrow(
          'transaction API',
        );
        expect(owner.isTransactionActive).toEqual(true);
        broadcast.mockRestore();
        await owner.rollbackTransaction();
        await expect(source.query('SELECT 1')).resolves.toEqual([{ '1': 1 }]);
      });

      /**
       * @target CustomQueryRunner.commitTransaction releases ownership
       * when a subscriber fails after completed %s
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * - Mocked Broadcaster.broadcast injects the named lifecycle
       * failure.
       * @scenario
       * - For each finish operation, make its after-finish broadcast throw
       * after the SQL completion. Await the error, inspect inactive state,
       * restore the broadcaster and query normally.
       * @expected
       * - The subscriber error propagates while completed SQL releases
       * ownership.
       */
      it.each(commitFinishes)(
        'releases ownership when a subscriber fails after completed %s',
        async (operation) => {
          const owner = runner();
          await owner.startTransaction();
          const broadcast = mockBroadcast(owner).mockImplementation(
            async (
              ...[event]: Parameters<typeof owner.broadcaster.broadcast>
            ) => {
              if (
                event ===
                (operation === 'commit'
                  ? 'AfterTransactionCommit'
                  : 'AfterTransactionRollback')
              )
                throw new Error('after finish failure');
            },
          );
          await expect(
            operation === 'commit'
              ? owner.commitTransaction()
              : owner.rollbackTransaction(),
          ).rejects.toThrow('after finish failure');
          expect(owner.isTransactionActive).toEqual(false);
          broadcast.mockRestore();
          await expect(source.query('SELECT 1')).resolves.toEqual([{ '1': 1 }]);
        },
      );
    });
  });

  describe('rollbackTransaction', () => {
    /**
     * @target CustomQueryRunner.rollbackTransaction should throw Error
     * when no transaction started
     * @dependencies
     * - Real in-memory SQLite datasource and ownership-aware runner.
     * @scenario
     * - create a datasource
     * - create a query runner and connect to it
     * - call rollbackTransaction on it
     * @expected
     * - throw an error
     */
    it('should throw Error when no transaction started', async () => {
      const dataSource = await createAndInitializeDataSource();
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await expect(() => queryRunner.rollbackTransaction()).rejects.toThrow();
    });
    describe('SQLite ownership', () => {
      let source: DataSource;
      const runner = registerSqliteOwnershipHooks((initialized) => {
        source = initialized;
      });

      /**
       * @target CustomQueryRunner.rollbackTransaction blocks foreign
       * ordinary updates until outer %s, then preserves their result
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * @scenario
       * - For each finish operation, update one row in the owning
       * transaction and start an ordinary update to another row. Verify
       * that update waits, finish the owner and read both rows.
       * @expected
       * - The foreign update survives; the owner row reflects the selected
       * commit or rollback.
       */
      it.each(rollbackFinishes)(
        'blocks foreign ordinary updates until outer %s, then preserves their result',
        async (finish) => {
          const owner = runner();
          await owner.startTransaction();
          await owner.manager
            .getRepository(row)
            .update({ id: 1 }, { value: 'uncommitted' });
          let done = false;
          const foreign = source
            .getRepository(row)
            .update({ id: 2 }, { value: 'independent-winner' })
            .then(() => {
              done = true;
            });
          await tick();
          expect(done).toEqual(false);
          if (finish === 'commit') await owner.commitTransaction();
          else await owner.rollbackTransaction();
          await foreign;
          expect(
            (await source.getRepository(row).findOneByOrFail({ id: 2 })).value,
          ).toEqual('independent-winner');
          expect(
            (await source.getRepository(row).findOneByOrFail({ id: 1 })).value,
          ).toEqual(finish === 'commit' ? 'uncommitted' : 'target');
        },
      );

      /**
       * @target CustomQueryRunner.rollbackTransaction blocks foreign reads
       * from observing uncommitted data before %s
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * @scenario
       * - For each finish operation, write inside a transaction and start
       * an ordinary read. Verify the read is pending, finish the
       * transaction and inspect the read result.
       * @expected
       * - The ordinary read waits and returns only the committed or
       * rolled-back value.
       */
      it.each(rollbackFinishes)(
        'blocks foreign reads from observing uncommitted data before %s',
        async (finish) => {
          const owner = runner();
          await owner.startTransaction();
          await owner.manager
            .getRepository(row)
            .update({ id: 1 }, { value: 'uncommitted' });
          let done = false;
          const read = source
            .getRepository(row)
            .findOneByOrFail({ id: 1 })
            .then((value) => {
              done = true;
              return value;
            });
          await tick();
          expect(done).toEqual(false);
          if (finish === 'commit') await owner.commitTransaction();
          else await owner.rollbackTransaction();
          expect((await read).value).toEqual(
            finish === 'commit' ? 'uncommitted' : 'target',
          );
        },
      );

      /**
       * @target CustomQueryRunner.rollbackTransaction keeps ownership
       * through nested %s until outer rollback
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * @scenario
       * - For each finish operation, write at outer and nested depths and
       * start a foreign update. Finish the nested layer, inspect its value
       * and pending foreign update, then roll back the outer layer.
       * @expected
       * - Nested completion retains ownership; outer rollback restores its
       * row and the foreign update then succeeds.
       */
      it.each(rollbackFinishes)(
        'keeps ownership through nested %s until outer rollback',
        async (finish) => {
          const owner = runner();
          await owner.startTransaction();
          await owner.manager
            .getRepository(row)
            .update({ id: 1 }, { value: 'outer' });
          await owner.startTransaction();
          await owner.manager
            .getRepository(row)
            .update({ id: 1 }, { value: 'inner' });
          let done = false;
          const foreign = source
            .getRepository(row)
            .update({ id: 2 }, { value: 'foreign' })
            .then(() => {
              done = true;
            });
          if (finish === 'commit') await owner.commitTransaction();
          else await owner.rollbackTransaction();
          expect(owner.isTransactionActive).toEqual(true);
          expect(
            (await owner.manager.getRepository(row).findOneByOrFail({ id: 1 }))
              .value,
          ).toEqual(finish === 'commit' ? 'inner' : 'outer');
          await tick();
          expect(done).toEqual(false);
          await owner.rollbackTransaction();
          await foreign;
          expect(
            (await source.getRepository(row).findOneByOrFail({ id: 1 })).value,
          ).toEqual('target');
          expect(
            (await source.getRepository(row).findOneByOrFail({ id: 2 })).value,
          ).toEqual('foreign');
        },
      );

      /**
       * @target CustomQueryRunner.rollbackTransaction retains ownership on
       * failed %s until explicit recovery
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * - Mocked SqliteQueryRunner.query injects the named SQL failure.
       * @scenario
       * - For each finish operation, write inside the owner and make the
       * base query method reject that finish. Verify active state and
       * release refusal; start a foreign update and verify it waits.
       * Restore the query method and explicitly roll back the owner.
       * @expected
       * - Failed completion retains ownership; explicit recovery restores
       * the owner row and allows the waiting foreign update.
       */
      it.each(rollbackFinishes)(
        'retains ownership on failed %s until explicit recovery',
        async (operation) => {
          const owner = runner();
          await owner.startTransaction();
          await owner.manager
            .getRepository(row)
            .update({ id: 1 }, { value: 'uncommitted' });
          const original = SqliteQueryRunner.prototype.query;
          const query = mockSqliteQuery().mockImplementation(function (
            this: SqliteQueryRunner,
            sql,
            parameters,
            structured,
          ) {
            if (sql === (operation === 'commit' ? 'COMMIT' : 'ROLLBACK'))
              return Promise.reject(new Error('fixture finish failure'));
            return original.call(this, sql, parameters, structured);
          });
          await expect(
            operation === 'commit'
              ? owner.commitTransaction()
              : owner.rollbackTransaction(),
          ).rejects.toThrow('finish failure');
          expect(owner.isTransactionActive).toEqual(true);
          await expect(owner.release()).rejects.toThrow('Finish');
          let done = false;
          const foreign = source
            .getRepository(row)
            .update({ id: 2 }, { value: 'winner' })
            .then(() => {
              done = true;
            });
          await tick();
          expect(done).toEqual(false);
          query.mockRestore();
          await owner.rollbackTransaction();
          await foreign;
          expect(
            (await source.getRepository(row).findOneByOrFail({ id: 1 })).value,
          ).toEqual('target');
          expect(
            (await source.getRepository(row).findOneByOrFail({ id: 2 })).value,
          ).toEqual('winner');
        },
      );

      /**
       * @target CustomQueryRunner.rollbackTransaction releases ownership
       * when a subscriber fails after completed %s
       * @dependencies
       * - Real ownership-aware datasource, TypeORM SQLite driver and
       * in-memory records.
       * - Mocked Broadcaster.broadcast injects the named lifecycle
       * failure.
       * @scenario
       * - For each finish operation, make its after-finish broadcast throw
       * after the SQL completion. Await the error, inspect inactive state,
       * restore the broadcaster and query normally.
       * @expected
       * - The subscriber error propagates while completed SQL releases
       * ownership.
       */
      it.each(rollbackFinishes)(
        'releases ownership when a subscriber fails after completed %s',
        async (operation) => {
          const owner = runner();
          await owner.startTransaction();
          const broadcast = mockBroadcast(owner).mockImplementation(
            async (
              ...[event]: Parameters<typeof owner.broadcaster.broadcast>
            ) => {
              if (
                event ===
                (operation === 'commit'
                  ? 'AfterTransactionCommit'
                  : 'AfterTransactionRollback')
              )
                throw new Error('after finish failure');
            },
          );
          await expect(
            operation === 'commit'
              ? owner.commitTransaction()
              : owner.rollbackTransaction(),
          ).rejects.toThrow('after finish failure');
          expect(owner.isTransactionActive).toEqual(false);
          broadcast.mockRestore();
          await expect(source.query('SELECT 1')).resolves.toEqual([{ '1': 1 }]);
        },
      );
    });
  });
});
