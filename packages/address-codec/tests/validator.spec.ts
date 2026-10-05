import { UnsupportedChainError, validateAddress } from '../lib';

describe('validateAddress', () => {
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

  /**
   * @target validateAddress validates the Solana public key through the shared codec
   * @dependencies
   * - public Solana address fixture
   * - No dependencies or test helpers are mocked
   * @scenario
   * - validate the fixture Solana public key through the shared address codec
   * - assert validation does not throw
   * @expected
   * - the shared codec accepts the fixture Solana public key
   */
  it('validates the Solana public key through the shared codec', () => {
    expect(() =>
      validateAddress('solana', '111111116UjcYNBG9GTK4uq2f7yYEbuifCzoLMGS'),
    ).not.toThrow();
  });
});
