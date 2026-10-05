import {
  ergoToSolanaUnits,
  ERGO_SIGNED_AMOUNT_MAX,
  SOLANA_U64_MAX,
  SolanaAmountConversionError,
  solanaToErgoUnits,
} from '../lib';

describe('solanaToErgoUnits', () => {
  /**
   * @target solanaToErgoUnits
   * preserves exact integer amounts above Number.MAX_SAFE_INTEGER
   * @dependencies
   * - ergoToSolanaUnits
   * - No dependencies or test helpers are mocked
   * @scenario
   * - set an amount one greater than Number.MAX_SAFE_INTEGER
   * - convert it in both directions with matching decimal scales
   * - compare each converted amount with the original
   * @expected
   * - both conversions preserve the exact amount
   */
  it('preserves exact integer amounts above Number.MAX_SAFE_INTEGER', () => {
    const amount = 9_007_199_254_740_993n;
    expect(solanaToErgoUnits(amount, 9, 9)).toEqual(amount);
    expect(ergoToSolanaUnits(amount, 9, 9)).toEqual(amount);
  });

  /**
   * @target solanaToErgoUnits
   * converts decimal scales exactly in both directions
   * @dependencies
   * - ergoToSolanaUnits
   * - No dependencies or test helpers are mocked
   * @scenario
   * - convert 1,234,000 units from 9 decimals to 6 decimals
   * - convert 1,234 units from 6 decimals to 9 decimals
   * - compare both results with their exact expected values
   * @expected
   * - the scale conversions return 1,234 and 1,234,000 respectively
   */
  it('converts decimal scales exactly in both directions', () => {
    expect(solanaToErgoUnits(1_234_000n, 9, 6)).toEqual(1_234n);
    expect(ergoToSolanaUnits(1_234n, 6, 9)).toEqual(1_234_000n);
  });

  /**
   * @target solanaToErgoUnits
   * rejects dust instead of rounding it into a different amount
   * @dependencies
   * - SolanaAmountConversionError
   * - ergoToSolanaUnits
   * - No dependencies or test helpers are mocked
   * @scenario
   * - convert a Solana amount that has dust at the requested Ergo scale
   * - convert an Ergo amount that has dust at the requested Solana scale
   * - assert each conversion throws the existing MAPPING_DUST error
   * @expected
   * - both conversions reject the unrepresentable amount with MAPPING_DUST
   */
  it('rejects dust instead of rounding it into a different amount', () => {
    expect(() => solanaToErgoUnits(1_234_001n, 9, 6)).toThrow(
      new SolanaAmountConversionError('MAPPING_DUST'),
    );
    expect(() => ergoToSolanaUnits(1_235n, 6, 3)).toThrow(
      new SolanaAmountConversionError('MAPPING_DUST'),
    );
  });

  /**
   * @target solanaToErgoUnits
   * enforces the source u64 and destination Ergo signed-63-bit bounds
   * @dependencies
   * - ERGO_SIGNED_AMOUNT_MAX
   * - SOLANA_U64_MAX
   * - SolanaAmountConversionError
   * - ergoToSolanaUnits
   * - No dependencies or test helpers are mocked
   * @scenario
   * - convert the largest allowed Ergo signed amount at equal scales
   * - check the existing source-u64, destination-Ergo and outbound-Ergo overflow inputs
   * - check that the maximum Solana u64 also exceeds the Ergo destination bound
   * @expected
   * - the maximum valid Ergo amount is preserved and each out-of-range input throws its asserted error
   */
  it('enforces the source u64 and destination Ergo signed-63-bit bounds', () => {
    expect(solanaToErgoUnits(ERGO_SIGNED_AMOUNT_MAX, 9, 9)).toEqual(
      ERGO_SIGNED_AMOUNT_MAX,
    );
    expect(() => solanaToErgoUnits(SOLANA_U64_MAX + 1n, 9, 9)).toThrow(
      new SolanaAmountConversionError('SOLANA_U64_RANGE'),
    );
    expect(() => solanaToErgoUnits(ERGO_SIGNED_AMOUNT_MAX + 1n, 9, 9)).toThrow(
      new SolanaAmountConversionError('ERGO_SIGNED_RANGE'),
    );
    expect(() => ergoToSolanaUnits(ERGO_SIGNED_AMOUNT_MAX + 1n, 9, 9)).toThrow(
      new SolanaAmountConversionError('ERGO_SIGNED_RANGE'),
    );
    expect(() => solanaToErgoUnits(SOLANA_U64_MAX, 9, 9)).toThrow(
      new SolanaAmountConversionError('ERGO_SIGNED_RANGE'),
    );
  });
});

describe('ergoToSolanaUnits', () => {
  /**
   * @target ergoToSolanaUnits
   * enforces decimals and outbound Solana u64 bounds
   * @dependencies
   * - ERGO_SIGNED_AMOUNT_MAX
   * - SolanaAmountConversionError
   * - solanaToErgoUnits
   * - No dependencies or test helpers are mocked
   * @scenario
   * - convert with an unsupported Solana decimal count
   * - convert the maximum Ergo signed amount to a scale that exceeds Solana u64
   * - assert the existing DECIMALS_RANGE and SOLANA_U64_RANGE errors
   * @expected
   * - invalid decimals and an oversized outbound amount are rejected with their asserted errors
   */
  it('enforces decimals and outbound Solana u64 bounds', () => {
    expect(() => solanaToErgoUnits(1n, 19, 9)).toThrow(
      new SolanaAmountConversionError('DECIMALS_RANGE'),
    );
    expect(() => ergoToSolanaUnits(ERGO_SIGNED_AMOUNT_MAX, 0, 18)).toThrow(
      new SolanaAmountConversionError('SOLANA_U64_RANGE'),
    );
  });
});
