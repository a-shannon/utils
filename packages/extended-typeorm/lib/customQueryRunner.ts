import { Mutex, MutexInterface } from 'async-mutex';
import { SqliteDriver } from 'typeorm/driver/sqlite/SqliteDriver';
import { SqliteQueryRunner } from 'typeorm/driver/sqlite/SqliteQueryRunner';
import { IsolationLevel } from 'typeorm/driver/types/IsolationLevel';

/** Use this runner's manager inside a transaction; other runners wait for it. */
class CustomQueryRunner extends SqliteQueryRunner {
  private releaseMutex: MutexInterface.Releaser | null = null;
  private transitioning = false;
  private queryLease: MutexInterface.Releaser | null = null;
  private queryLeasePending: Promise<void> | undefined;
  private activeQueries = 0;
  private failedStartDepth: number | undefined;
  readonly mutex: Mutex;

  /** Shares the driver's ownership mutex across SQLite query runners. */
  constructor(driver: SqliteDriver, mutex: Mutex) {
    super(driver);
    this.mutex = mutex;
  }

  /** Acquires transaction ownership and opens a transaction or nested savepoint. */
  startTransaction = async (isolationLevel?: IsolationLevel): Promise<void> => {
    this.assertStartAcknowledged();
    this.beginTransition();
    const depthBefore = this.transactionDepth;
    try {
      if (this.driver.transactionSupport === 'none')
        throw new Error('SQLite transactions are not supported');
      if (
        this.isTransactionActive &&
        this.driver.transactionSupport === 'simple'
      )
        throw new Error('SQLite transaction is already active');
      if (
        isolationLevel &&
        isolationLevel !== 'READ UNCOMMITTED' &&
        isolationLevel !== 'SERIALIZABLE'
      )
        throw new Error(
          'SQLite only supports SERIALIZABLE and READ UNCOMMITTED isolation',
        );
      if (!this.releaseMutex) this.releaseMutex = await this.mutex.acquire();
      this.isTransactionActive = true;
      await this.broadcaster.broadcast('BeforeTransactionStart');
      if (this.transactionDepth === 0) {
        if (isolationLevel)
          await this.query(
            `PRAGMA read_uncommitted = ${isolationLevel === 'READ UNCOMMITTED' ? 'true' : 'false'}`,
          );
        await super.query('BEGIN TRANSACTION');
      } else {
        await super.query(`SAVEPOINT typeorm_${this.transactionDepth}`);
      }
      this.transactionDepth++;
      await this.broadcaster.broadcast('AfterTransactionStart');
    } catch (error) {
      // Some ORM callers start a transaction outside their cleanup try block.
      // Top-level callers such as MigrationExecutor may not clean up a failed
      // start. Nested manager.transaction does roll back its failed layer.
      if (depthBefore === 0 && this.transactionDepth > 0) {
        try {
          await super.query('ROLLBACK');
          this.transactionDepth = 0;
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'SQLite transaction start and rollback both failed',
          );
        }
      }
      if (depthBefore > 0 && this.transactionDepth === depthBefore)
        this.failedStartDepth = depthBefore;
      this.isTransactionActive = this.transactionDepth > 0;
      throw error;
    } finally {
      this.transitioning = false;
      this.releaseIfFinished();
    }
  };

  /** Commits the active layer while retaining ownership for any outer transaction. */
  commitTransaction = async (): Promise<void> => {
    this.assertStartAcknowledged();
    if (!this.releaseMutex) {
      throw new Error('Cannot commit transaction before starting it');
    }
    this.beginTransition();
    try {
      await this.broadcaster.broadcast('BeforeTransactionCommit');
      if (this.transactionDepth > 1) {
        await super.query(
          `RELEASE SAVEPOINT typeorm_${this.transactionDepth - 1}`,
        );
      } else {
        await super.query('COMMIT');
        this.isTransactionActive = false;
      }
      this.transactionDepth--;
      await this.broadcaster.broadcast('AfterTransactionCommit');
    } finally {
      this.transitioning = false;
      this.releaseIfFinished();
    }
  };

  /** Rolls back one opened layer or acknowledges a failed nested start. */
  rollbackTransaction = async (): Promise<void> => {
    if (!this.releaseMutex) {
      throw new Error('Cannot rollback transaction before starting it');
    }
    this.beginTransition();
    try {
      // No savepoint was opened by this failed nested start. Acknowledge its
      // rollback without touching the pre-existing outer transaction. Until
      // this acknowledgement, query/commit/start fail instead of guessing.
      if (this.failedStartDepth === this.transactionDepth) {
        this.failedStartDepth = undefined;
        return;
      }
      await this.broadcaster.broadcast('BeforeTransactionRollback');
      if (this.transactionDepth > 1) {
        await super.query(
          `ROLLBACK TO SAVEPOINT typeorm_${this.transactionDepth - 1}`,
        );
      } else {
        await super.query('ROLLBACK');
        this.isTransactionActive = false;
      }
      this.transactionDepth--;
      await this.broadcaster.broadcast('AfterTransactionRollback');
    } finally {
      this.transitioning = false;
      if (this.failedStartDepth === this.transactionDepth)
        this.failedStartDepth = undefined;
      this.releaseIfFinished();
    }
  };

  /** Requires rollback acknowledgement before reusing a failed nested start. */
  private assertStartAcknowledged = (): void => {
    if (this.failedStartDepth !== undefined)
      throw new Error(
        'Roll back the failed SQLite transaction start before using this runner',
      );
  };

  /** Prevents overlapping transaction transitions and queries on this runner. */
  private beginTransition = (): void => {
    if (this.transitioning || this.activeQueries > 0)
      throw new Error(
        'SQLite transaction operation is already pending on this runner',
      );
    this.transitioning = true;
  };

  /** Releases transaction ownership only after all layers and operations finish. */
  private releaseIfFinished = (): void => {
    if (
      !this.isTransactionActive &&
      this.transactionDepth === 0 &&
      !this.transitioning &&
      this.activeQueries === 0
    ) {
      this.releaseMutex?.();
      this.releaseMutex = null;
    }
  };

  /** Runs SQL under ownership while refusing transaction-control statements. */
  query = async (
    sql: string,
    parameters?: unknown[],
    useStructuredResult = false,
  ): ReturnType<SqliteQueryRunner['query']> => {
    this.assertStartAcknowledged();
    // Transaction state must be managed through QueryRunner's transaction API.
    // Ignore leading whitespace/comments, not SQL inside strings or triggers.
    const command = sql.replace(
      /^(?:\s|;|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/,
      '',
    );
    if (/^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(command))
      throw new Error(
        'Use the QueryRunner transaction API for SQLite transactions',
      );
    if (this.transitioning && !this.releaseMutex)
      throw new Error(
        'SQLite transaction operation is already pending on this runner',
      );
    this.activeQueries++;
    try {
      if (!this.releaseMutex && !this.queryLease) {
        if (!this.queryLeasePending)
          this.queryLeasePending = this.mutex.acquire().then((release) => {
            this.queryLease = release;
            this.queryLeasePending = undefined;
          });
        await this.queryLeasePending;
      }
      return await super.query(sql, parameters, useStructuredResult);
    } finally {
      this.activeQueries--;
      if (this.activeQueries === 0 && this.queryLease) {
        this.queryLease();
        this.queryLease = null;
      }
      this.releaseIfFinished();
    }
  };

  /** Releases an idle runner and refuses to abandon active transaction ownership. */
  release = async (): Promise<void> => {
    if (this.releaseMutex || this.transitioning || this.activeQueries > 0)
      throw new Error(
        'Finish the SQLite transaction before releasing its query runner',
      );
    await super.release();
  };
}

export { CustomQueryRunner };
