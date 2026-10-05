import { DataSource, DataSourceOptions } from 'typeorm';

import { SqliteDriver } from './sqliteDriver';

class CustomDataSource extends DataSource {
  /** Installs the ownership-aware driver for SQLite and preserves other drivers. */
  constructor(options: DataSourceOptions) {
    super(options);
    if (options.type === 'sqlite') {
      this.driver = new SqliteDriver(this);
    }
  }
}

export { CustomDataSource as DataSource };
