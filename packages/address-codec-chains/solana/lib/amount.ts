export const SOLANA_U64_MAX = (1n << 64n) - 1n;
export const ERGO_SIGNED_AMOUNT_MAX = (1n << 63n) - 1n;

export type SolanaAmountErrorCode =
  | 'SOLANA_U64_RANGE'
  | 'ERGO_SIGNED_RANGE'
  | 'DECIMALS_RANGE'
  | 'MAPPING_DUST';

export class SolanaAmountConversionError extends RangeError {
  /** Creates an amount-conversion error with its stable reason code. */
  constructor(readonly code: SolanaAmountErrorCode) {
    super(`SolanaAmountConversionError: ${code}`);
    this.name = 'SolanaAmountConversionError';
  }
}

/** Rejects decimal counts outside the supported Solana and Ergo range. */
const validateDecimals = (decimals: number): void => {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18)
    throw new SolanaAmountConversionError('DECIMALS_RANGE');
};

/** Rescales integer units exactly, rejecting any remainder as mapping dust. */
const convertExactUnits = (
  amount: bigint,
  sourceDecimals: number,
  destinationDecimals: number,
): bigint => {
  const delta = destinationDecimals - sourceDecimals;
  if (delta >= 0) return amount * 10n ** BigInt(delta);

  const divisor = 10n ** BigInt(-delta);
  if (amount % divisor !== 0n)
    throw new SolanaAmountConversionError('MAPPING_DUST');
  return amount / divisor;
};

/** Converts a Solana u64 amount to signed 63-bit Ergo units without dust. */
export const solanaToErgoUnits = (
  amount: bigint,
  solanaDecimals: number,
  ergoDecimals: number,
): bigint => {
  if (amount < 0n || amount > SOLANA_U64_MAX)
    throw new SolanaAmountConversionError('SOLANA_U64_RANGE');
  validateDecimals(solanaDecimals);
  validateDecimals(ergoDecimals);

  const result = convertExactUnits(amount, solanaDecimals, ergoDecimals);
  if (result > ERGO_SIGNED_AMOUNT_MAX)
    throw new SolanaAmountConversionError('ERGO_SIGNED_RANGE');
  return result;
};

/** Converts Ergo units to a Solana u64 amount without dust. */
export const ergoToSolanaUnits = (
  amount: bigint,
  ergoDecimals: number,
  solanaDecimals: number,
): bigint => {
  if (amount < 0n || amount > ERGO_SIGNED_AMOUNT_MAX)
    throw new SolanaAmountConversionError('ERGO_SIGNED_RANGE');
  validateDecimals(ergoDecimals);
  validateDecimals(solanaDecimals);

  const result = convertExactUnits(amount, ergoDecimals, solanaDecimals);
  if (result > SOLANA_U64_MAX)
    throw new SolanaAmountConversionError('SOLANA_U64_RANGE');
  return result;
};
