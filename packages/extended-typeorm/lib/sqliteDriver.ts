import { Mutex } from 'async-mutex';
import { DataSource, QueryRunner, ReplicationMode } from 'typeorm';
import { SqliteDriver } from 'typeorm/driver/sqlite/SqliteDriver';

import { CustomQueryRunner } from './customQueryRunner';

class CustomSqliteDriver extends SqliteDriver {
  protected mutex: Mutex;

  /** Creates one ownership mutex for this SQLite connection. */
  constructor(connection: DataSource) {
    super(connection);
    this.mutex = new Mutex();
  }

  /** Creates an independent runner sharing the connection's ownership mutex. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  createQueryRunner = (mode: ReplicationMode): QueryRunner => {
    return new CustomQueryRunner(this, this.mutex);
  };
}

export { CustomSqliteDriver as SqliteDriver };
