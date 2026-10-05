import { UnsupportedChainError, decodeAddress } from '../lib';

describe('decodeAddress', () => {
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

  /**
   * @target decodeAddress decodes the Solana public key through the shared codec
   * @dependencies
   * - public Solana hexadecimal and address fixtures
   * - No dependencies or test helpers are mocked
   * @scenario
   * - decode the fixture Solana public key through the shared address codec
   * - compare the result with its fixture Base58 representation
   * @expected
   * - the shared codec returns the fixture Base58 representation
   */
  it('decodes the Solana public key through the shared codec', () => {
    expect(
      decodeAddress(
        'solana',
        '000000000000000001093b485f60b9a4073d68d186a239b39d921efbe0c56987',
      ),
    ).toEqual('111111116UjcYNBG9GTK4uq2f7yYEbuifCzoLMGS');
  });
});
