import bs58 from 'bs58';

import {
  decodeSolanaAddress,
  encodeSolanaAddress,
  SOLANA_CHAIN,
  UnsupportedAddressError,
  validateSolanaAddress,
} from '../lib';

const publicKey = '111111116UjcYNBG9GTK4uq2f7yYEbuifCzoLMGS';
const publicKeyHex =
  '000000000000000001093b485f60b9a4073d68d186a239b39d921efbe0c56987';

describe('encodeSolanaAddress', () => {
  /**
   * @target encodeSolanaAddress
   * encodes and decodes a 32-byte public key without changing leading zero bytes
   * @dependencies
   * - bs58
   * - publicKey and publicKeyHex fixtures
   * - decodeSolanaAddress
   * - SOLANA_CHAIN
   * - No dependencies or test helpers are mocked
   * @scenario
   * - check the exported chain identifier
   * - encode the public key and decode its lowercase and uppercase hex forms
   * - compare all results with their fixture values
   * @expected
   * - the chain identifier and all address representations match the fixtures
   */
  it('encodes and decodes a 32-byte public key without changing leading zero bytes', () => {
    expect(SOLANA_CHAIN).toEqual('solana');
    expect(encodeSolanaAddress(publicKey)).toEqual(publicKeyHex);
    expect(decodeSolanaAddress(publicKeyHex)).toEqual(publicKey);
    expect(decodeSolanaAddress(publicKeyHex.toUpperCase())).toEqual(publicKey);
  });

  /**
   * @target encodeSolanaAddress
   * preserves the all-zero public key
   * @dependencies
   * - public key fixture generated from 32 zero bytes
   * - decodeSolanaAddress
   * - No dependencies or test helpers are mocked
   * @scenario
   * - construct the all-zero public key in Base58
   * - encode it and decode the 32-byte zero hex value
   * - compare both results with the fixture representations
   * @expected
   * - the all-zero public key retains all 32 leading zero bytes in both directions
   */
  it('preserves the all-zero public key', () => {
    const zeroKey = '1'.repeat(32);
    expect(encodeSolanaAddress(zeroKey)).toEqual('00'.repeat(32));
    expect(decodeSolanaAddress('00'.repeat(32))).toEqual(zeroKey);
  });
});

describe('validateSolanaAddress', () => {
  /**
   * @target validateSolanaAddress
   * accepts any 32-byte key, including bytes that are not an Ed25519 point
   * @dependencies
   * - bs58
   * - 32-byte 0xff fixture
   * - encodeSolanaAddress
   * - No dependencies or test helpers are mocked
   * @scenario
   * - encode 32 bytes of 0xff as a Solana address
   * - assert address validation does not throw
   * - encode the address and compare it with the 32-byte 0xff hex value
   * @expected
   * - the off-curve 32-byte key passes address validation and is encoded unchanged
   */
  it('accepts any 32-byte key, including bytes that are not an Ed25519 point', () => {
    const offCurveKey = bs58.encode(Buffer.alloc(32, 0xff));
    expect(() => validateSolanaAddress(offCurveKey)).not.toThrow();
    expect(encodeSolanaAddress(offCurveKey)).toEqual('ff'.repeat(32));
  });

  /**
   * @target validateSolanaAddress
   * rejects an invalid Base58 public key: %s
   * @dependencies
   * - bs58
   * - UnsupportedAddressError
   * - encodeSolanaAddress
   * - No dependencies or test helpers are mocked
   * @scenario
   * - for each listed invalid address, call the encoder and validator
   * - assert both calls throw UnsupportedAddressError
   * @expected
   * - every listed invalid Base58 public key is rejected by both functions
   */
  it.each([
    '',
    '0'.repeat(32),
    '1'.repeat(31),
    '1'.repeat(33),
    bs58.encode(Buffer.alloc(33, 0x01)),
  ])('rejects an invalid Base58 public key: %s', (address) => {
    expect(() => encodeSolanaAddress(address)).toThrow(UnsupportedAddressError);
    expect(() => validateSolanaAddress(address)).toThrow(
      UnsupportedAddressError,
    );
  });
});

describe('decodeSolanaAddress', () => {
  /**
   * @target decodeSolanaAddress
   * rejects malformed encoded bytes: %s
   * @dependencies
   * - UnsupportedAddressError
   * - No dependencies or test helpers are mocked
   * @scenario
   * - for each listed malformed or incorrectly sized hex string, call the decoder
   * - assert the decoder throws UnsupportedAddressError
   * @expected
   * - every listed malformed encoded byte string is rejected
   */
  it.each([
    '',
    '0x' + '00'.repeat(32),
    'gg'.repeat(32),
    '00'.repeat(31),
    '00'.repeat(33),
  ])('rejects malformed encoded bytes: %s', (encodedAddress) => {
    expect(() => decodeSolanaAddress(encodedAddress)).toThrow(
      UnsupportedAddressError,
    );
  });
});
