import { registerSqliteOwnershipHooks } from './testUtils';

describe('CustomSqliteDriver', () => {
  describe('createQueryRunner', () => {
    const runner = registerSqliteOwnershipHooks(() => {});

    /**
     * @target CustomSqliteDriver.createQueryRunner returns independent
     * logical runners over one connection
     * @dependencies
     * - Real ownership-aware datasource, TypeORM SQLite driver and
     * in-memory records.
     * @scenario
     * - Create two logical runners and connect both to the fixture
     * database.
     * @expected
     * - The runner references differ and their physical connection
     * reference is identical.
     */
    it('returns independent logical runners over one connection', async () => {
      const first = runner();
      const second = runner();
      expect(first).not.toBe(second);
      expect(await first.connect()).toBe(await second.connect());
    });
  });
});
