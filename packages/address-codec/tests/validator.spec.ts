import { UnsupportedChainError, validateAddress } from '../lib';

describe('validateAddress', () => {
  describe.each(['ethereum', 'binance', 'base', 'avalanche'])(
    '%s EVM validator',
    (chain) => {
      const address = '0x' + 'ab'.repeat(20);
      /**
       * @target validateAddress accepts a lowercase 20-byte EVM address
       * @dependencies EVM address codec
       * @scenario Validate a complete lowercase address on each supported EVM chain
       * @expected Validation completes without an exception
       */
      it('accepts a lowercase 20-byte EVM address', () => {
        expect(() => validateAddress(chain, address)).not.toThrow();
      });
      /**
       * @target validateAddress rejects %s
       * @dependencies EVM address codec
       * @scenario Validate an address with invalid size, prefix, bytes or letter case
       * @expected Validation throws for each independently invalid address
       */
      it.each([
        ['short address', '0x' + 'ab'.repeat(19)],
        ['long address', '0x' + 'ab'.repeat(21)],
        ['wrong prefix', '1x' + 'ab'.repeat(20)],
        ['nonhex characters', '0x' + 'gg'.repeat(20)],
        ['mixed case', '0xAb' + 'ab'.repeat(19)],
      ])('rejects %s', (_name, invalid) => {
        expect(() => validateAddress(chain, invalid)).toThrow();
      });
    },
  );
  /**
   * @target `validateAddress` should throw error when chain is not supported
   * @dependencies
   * @scenario
   * - run test
   * @expected
   * - it should throw UnsupportedChain error
   */
  it('should throw error when chain is not supported', () => {
    expect(() => {
      validateAddress('unsupported-chain', '0011223344');
    }).toThrow(UnsupportedChainError);
  });
});
