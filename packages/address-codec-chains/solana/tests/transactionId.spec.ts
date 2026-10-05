import bs58 from 'bs58';

import {
  decodeSolanaTransactionId,
  encodeSolanaTransactionId,
  UnsupportedSolanaTransactionIdError,
  validateSolanaTransactionId,
} from '../lib';

describe('validateSolanaTransactionId', () => {
  /**
   * @target validateSolanaTransactionId
   * preserves exactly 64 signature bytes and their Base58 identity
   * @dependencies
   * - bs58
   * - 64-byte 0xff signature fixture
   * - UnsupportedSolanaTransactionIdError
   * - encodeSolanaTransactionId
   * - decodeSolanaTransactionId
   * - No dependencies or test helpers are mocked
   * @scenario
   * - encode 64 bytes of 0xff as a Base58 transaction ID
   * - encode and decode the signature and compare the bytes and ID
   * - assert transaction ID validation does not throw
   * @expected
   * - all 64 signature bytes and their Base58 transaction ID are preserved
   */
  it('preserves exactly 64 signature bytes and their Base58 identity', () => {
    const signature = Buffer.alloc(64, 0xff);
    const txId = bs58.encode(signature);
    expect(encodeSolanaTransactionId(signature)).toEqual(txId);
    expect(Buffer.from(decodeSolanaTransactionId(txId))).toEqual(signature);
    expect(() => validateSolanaTransactionId(txId)).not.toThrow();
  });
});

describe('encodeSolanaTransactionId', () => {
  /**
   * @target encodeSolanaTransactionId
   * preserves leading zero bytes in an all-zero signature
   * @dependencies
   * - 64-byte all-zero signature fixture
   * - decodeSolanaTransactionId
   * - No dependencies or test helpers are mocked
   * @scenario
   * - represent the all-zero signature as 64 leading Base58 zero characters
   * - decode it and compare the bytes with 64 zero bytes
   * - encode 64 zero bytes and compare the resulting transaction ID
   * @expected
   * - both conversions preserve all leading zero bytes
   */
  it('preserves leading zero bytes in an all-zero signature', () => {
    const txId = '1'.repeat(64);
    expect(Buffer.from(decodeSolanaTransactionId(txId))).toEqual(
      Buffer.alloc(64),
    );
    expect(encodeSolanaTransactionId(Buffer.alloc(64))).toEqual(txId);
  });

  /**
   * @target encodeSolanaTransactionId
   * rejects signatures that are not exactly 64 bytes
   * @dependencies
   * - UnsupportedSolanaTransactionIdError
   * - No dependencies or test helpers are mocked
   * @scenario
   * - attempt to encode a 63-byte signature
   * - assert encoding throws UnsupportedSolanaTransactionIdError
   * @expected
   * - a signature shorter than 64 bytes is rejected
   */
  it('rejects signatures that are not exactly 64 bytes', () => {
    expect(() => encodeSolanaTransactionId(Buffer.alloc(63))).toThrow(
      UnsupportedSolanaTransactionIdError,
    );
  });
});

describe('decodeSolanaTransactionId', () => {
  /**
   * @target decodeSolanaTransactionId
   * rejects an invalid transaction ID: %s
   * @dependencies
   * - bs58
   * - UnsupportedSolanaTransactionIdError
   * - No dependencies or test helpers are mocked
   * @scenario
   * - for each listed empty, invalid-character or wrong-length ID, call the decoder
   * - assert the decoder throws UnsupportedSolanaTransactionIdError
   * @expected
   * - every listed invalid transaction ID is rejected
   */
  it.each([
    '',
    '0'.repeat(64),
    bs58.encode(Buffer.alloc(63, 0x01)),
    bs58.encode(Buffer.alloc(65, 0x01)),
  ])('rejects an invalid transaction ID: %s', (txId) => {
    expect(() => decodeSolanaTransactionId(txId)).toThrow(
      UnsupportedSolanaTransactionIdError,
    );
  });
});
