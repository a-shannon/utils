import bs58 from 'bs58';

import { SOLANA_CHAIN } from './const';
import { UnsupportedAddressError } from './types';

const PUBLIC_KEY_BYTES = 32;

/** Decodes a canonical Base58 Solana address to exactly 32 public-key bytes. */
const decodePublicKey = (address: string): Uint8Array => {
  if (address.length < PUBLIC_KEY_BYTES || address.length > 44)
    throw new UnsupportedAddressError(
      SOLANA_CHAIN,
      address,
      'expected a Base58-encoded 32-byte public key',
    );

  try {
    const publicKey = bs58.decode(address);
    if (
      publicKey.length !== PUBLIC_KEY_BYTES ||
      bs58.encode(publicKey) !== address
    )
      throw new Error('expected a canonical Base58-encoded 32-byte public key');
    return publicKey;
  } catch (error) {
    throw new UnsupportedAddressError(
      SOLANA_CHAIN,
      address,
      error instanceof Error ? error.message : 'invalid Base58 public key',
    );
  }
};

/** Encodes a Solana Base58 public key as its 32 raw bytes in hexadecimal. */
export const encodeSolanaAddress = (address: string): string =>
  Buffer.from(decodePublicKey(address)).toString('hex');

/** Decodes the 32 raw bytes of a Solana public key from hexadecimal to Base58. */
export const decodeSolanaAddress = (encodedAddress: string): string => {
  if (!/^(?:[0-9a-fA-F]{2}){32}$/.test(encodedAddress))
    throw new UnsupportedAddressError(
      SOLANA_CHAIN,
      encodedAddress,
      'expected exactly 32 bytes (64 hexadecimal characters)',
    );

  return bs58.encode(Buffer.from(encodedAddress, 'hex'));
};

/** Validates the Base58 representation and byte length of a Solana public key. */
export const validateSolanaAddress = (address: string): void => {
  decodePublicKey(address);
};
