import { importBuiltIndex } from './indexTestUtils';

describe('index', () => {
  describe('import', () => {
    /**
     * @target index.import should expose the SQLite adapter through native ESM
     * @dependencies
     * - TypeScript compiler
     * - native Node ESM loader
     * @scenario
     * - build the package with its production TypeScript configuration
     * - import the emitted entry in Node without a TypeScript loader
     * @expected
     * - the datasource and bigint transformer exports are available
     */
    it('should expose the SQLite adapter through native ESM', () => {
      expect(importBuiltIndex()).toEqual([
        ['DataSource', 'function'],
        ['BigIntValueTransformer', 'function'],
      ]);
    });
  });
});
