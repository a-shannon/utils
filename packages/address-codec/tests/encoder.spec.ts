import { UnsupportedChainError, encodeAddress, decodeAddress } from '../lib';

describe('encodeAddress', () => {
  describe.each(['ethereum', 'binance', 'base', 'avalanche'])(
    '%s EVM encoder',
    (chain) => {
      const encoded = 'ab'.repeat(20);
      /**
       * @target encodeAddress encodes and round-trips a 20-byte EVM address
       * @dependencies EVM address codec and decodeAddress
       * @scenario Encode a lowercase address on each supported EVM chain and decode it
       * @expected The unprefixed bytes and round-tripped address match exactly
       */
      it('encodes and round-trips a 20-byte EVM address', () => {
        expect(encodeAddress(chain, '0x' + encoded)).toEqual(encoded);
        expect(
          decodeAddress(chain, encodeAddress(chain, '0x' + encoded)),
        ).toEqual('0x' + encoded);
      });
      /**
       * @target encodeAddress rejects %s
       * @dependencies EVM address codec
       * @scenario Encode an address with an invalid size or prefix
       * @expected The codec throws before returning an encoding
       */
      it.each([
        ['short address', '0x' + 'ab'.repeat(19)],
        ['long address', '0x' + 'ab'.repeat(21)],
        ['wrong prefix', '1x' + 'ab'.repeat(20)],
      ])('rejects %s', (_name, invalid) => {
        expect(() => encodeAddress(chain, invalid)).toThrow();
      });
    },
  );
  /**
   * @target `encodeAddress` should throw error when chain is not supported
   * @dependencies
   * @scenario
   * - run test & check thrown exception
   * @expected
   * - it should throw UnsupportedChain error
   */
  it('should throw error when chain is not supported', () => {
    expect(() => {
      encodeAddress('unsupported-chain', 'address');
    }).toThrow(UnsupportedChainError);
  });
});
