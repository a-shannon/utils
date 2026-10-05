import { UnsupportedChainError, encodeAddress } from '../lib';

describe('encodeAddress', () => {
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

  /**
   * @target encodeAddress encodes the Solana public key through the shared codec
   * @dependencies
   * - public Solana address and hexadecimal fixtures
   * - No dependencies or test helpers are mocked
   * @scenario
   * - encode the fixture Solana public key through the shared address codec
   * - compare the result with its fixture hexadecimal representation
   * @expected
   * - the shared codec returns the fixture hexadecimal representation
   */
  it('encodes the Solana public key through the shared codec', () => {
    expect(
      encodeAddress('solana', '111111116UjcYNBG9GTK4uq2f7yYEbuifCzoLMGS'),
    ).toEqual(
      '000000000000000001093b485f60b9a4073d68d186a239b39d921efbe0c56987',
    );
  });
});
