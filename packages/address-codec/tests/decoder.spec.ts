import { UnsupportedChainError, decodeAddress } from '../lib';

describe('decodeAddress', () => {
  describe.each(['ethereum', 'binance', 'base', 'avalanche'])(
    '%s EVM decoder',
    (chain) => {
      /**
       * @target decodeAddress decodes a 20-byte EVM address
       * @dependencies EVM address codec
       * @scenario Decode an unprefixed lowercase encoding on each supported EVM chain
       * @expected The address contains the same bytes with a 0x prefix
       */
      it('decodes a 20-byte EVM address', () => {
        expect(decodeAddress(chain, 'ab'.repeat(20))).toEqual(
          '0x' + 'ab'.repeat(20),
        );
      });
      /**
       * @target decodeAddress rejects %s
       * @dependencies EVM address codec
       * @scenario Decode an encoding with an invalid size or prefix
       * @expected The codec throws before returning an address
       */
      it.each([
        ['short encoding', 'ab'.repeat(19)],
        ['long encoding', 'ab'.repeat(21)],
        ['prefixed encoding', '0x' + 'ab'.repeat(20)],
      ])('rejects %s', (_name, invalid) => {
        expect(() => decodeAddress(chain, invalid)).toThrow();
      });
    },
  );
  /**
   * @target `decodeAddress` should throw error when chain is not supported
   * @dependencies
   * @scenario
   * - run test & check thrown exception
   * @expected
   * - it should throw UnsupportedChain error
   */
  it('should throw error when chain is not supported', () => {
    expect(() => {
      decodeAddress('unsupported-chain', '0011223344');
    }).toThrow(UnsupportedChainError);
  });
});
