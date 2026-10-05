import bs58 from 'bs58';

const TRANSACTION_SIGNATURE_BYTES = 64;

export class UnsupportedSolanaTransactionIdError extends Error {
  /** Creates the error used when a signature cannot form a canonical ID. */
  constructor() {
    super(
      'UnsupportedSolanaTransactionIdError: expected a canonical Base58-encoded 64-byte signature',
    );
    this.name = 'UnsupportedSolanaTransactionIdError';
  }
}

/** Encodes one Solana transaction signature as its canonical Base58 ID. */
export const encodeSolanaTransactionId = (signature: Uint8Array): string => {
  if (signature.length !== TRANSACTION_SIGNATURE_BYTES)
    throw new UnsupportedSolanaTransactionIdError();
  return bs58.encode(signature);
};

/** Decodes a canonical Solana transaction ID to its 64 signature bytes. */
export const decodeSolanaTransactionId = (txId: string): Uint8Array => {
  if (txId.length < TRANSACTION_SIGNATURE_BYTES || txId.length > 88)
    throw new UnsupportedSolanaTransactionIdError();

  try {
    const signature = bs58.decode(txId);
    if (
      signature.length !== TRANSACTION_SIGNATURE_BYTES ||
      bs58.encode(signature) !== txId
    )
      throw new Error('non-canonical or incorrect signature length');
    return signature;
  } catch {
    throw new UnsupportedSolanaTransactionIdError();
  }
};

/** Validates a canonical Solana transaction ID without changing its identity. */
export const validateSolanaTransactionId = (txId: string): void => {
  decodeSolanaTransactionId(txId);
};
