import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';

import { SOLANA_TOKEN_PROGRAM_ID } from '@rosen-bridge/address-codec-solana';

import {
  decodeSolanaHistoryAccount,
  SolanaHistoryAccountDecodeError,
} from '../../../lib/getRosenData/solana/historyAccountDecoder';
import { addresses } from './testData';

/** Decode a Base58 Solana address into its public-key bytes. */
const pubkeyBytes = (address: string): Buffer =>
  Buffer.from(bs58.decode(address));

/** Write an optional SPL public key using its COption tag and payload layout. */
const writeOptionKey = (
  bytes: Buffer,
  offset: number,
  value: string | null,
): void => {
  bytes.writeUInt32LE(value === null ? 0 : 1, offset);
  if (value !== null) pubkeyBytes(value).copy(bytes, offset + 4);
};

/** Build binary SPL Mint account data from the supplied field overrides. */
const packMint = (
  options: {
    mintAuthority?: string | null;
    supply?: bigint;
    decimals?: number;
    initialized?: number;
    freezeAuthority?: string | null;
  } = {},
): Buffer => {
  const bytes = Buffer.alloc(82);
  // None payload bytes are deliberately nonzero: the SPL unpacker ignores them.
  bytes.fill(0x6d, 4, 36);
  bytes.writeBigUInt64LE(options.supply ?? 1_000_000n, 36);
  bytes[44] = options.decimals ?? 6;
  bytes[45] = options.initialized ?? 1;
  bytes.fill(0x7e, 50, 82);
  writeOptionKey(bytes, 0, options.mintAuthority ?? null);
  writeOptionKey(bytes, 46, options.freezeAuthority ?? null);
  return bytes;
};

/** Build binary SPL Token account data from the supplied field overrides. */
const packTokenAccount = (
  options: {
    mint?: string;
    owner?: string;
    amount?: bigint;
    delegate?: string | null;
    state?: number;
    nativeTag?: number;
    nativeReserve?: bigint;
    delegatedAmount?: bigint;
    closeAuthority?: string | null;
  } = {},
): Buffer => {
  const bytes = Buffer.alloc(165);
  pubkeyBytes(options.mint ?? addresses.mint).copy(bytes, 0);
  pubkeyBytes(options.owner ?? addresses.sender).copy(bytes, 32);
  bytes.writeBigUInt64LE(options.amount ?? 0n, 64);
  bytes.fill(0x5a, 76, 108);
  bytes[108] = options.state ?? 1;
  bytes.writeUInt32LE(options.nativeTag ?? 0, 109);
  bytes.writeBigUInt64LE(options.nativeReserve ?? 0n, 113);
  bytes.writeBigUInt64LE(options.delegatedAmount ?? 0n, 121);
  bytes.fill(0x3c, 133, 165);
  writeOptionKey(bytes, 72, options.delegate ?? null);
  writeOptionKey(bytes, 129, options.closeAuthority ?? null);
  return bytes;
};

/** Wrap account bytes in the RPC record shape consumed by the history decoder. */
const record = (address: string, bytes: Buffer) => ({
  address,
  programOwner: SOLANA_TOKEN_PROGRAM_ID,
  executable: false,
  data: bytes.toString('base64'),
});

/** Change unused trailing Base64 bits to produce a noncanonical encoding. */
const noncanonicalBase64 = (data: string): string => {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const index = data.length - 3;
  const value = alphabet.indexOf(data[index]);
  const replacement = alphabet[(value & 0b110000) | 1];
  return `${data.slice(0, index)}${replacement}${data.slice(index + 1)}`;
};

/** Return the decoder error code, failing if decoding succeeds or throws another error. */
const decodeErrorCode = (value: unknown): string => {
  try {
    decodeSolanaHistoryAccount(value);
    throw new Error('Expected decoder error');
  } catch (error) {
    if (!(error instanceof SolanaHistoryAccountDecodeError)) throw error;
    return error.code;
  }
};

describe('decodeSolanaHistoryAccount', () => {
  /**
   * @target decodeSolanaHistoryAccount: decode canonical mint and token data.
   * @dependencies Binary SPL layouts, canonical Solana keys, and u64 fields.
   * @scenario Decode mint and token-account records at the maximum u64 value.
   * @expected Return canonical keys and decimal-string amounts without loss.
   */
  it('decodes exact mint and token layouts with canonical keys and u64 maximums', () => {
    const mint = decodeSolanaHistoryAccount(
      record(
        addresses.mint,
        packMint({
          supply: 18_446_744_073_709_551_615n,
          mintAuthority: addresses.sender,
          freezeAuthority: addresses.vault,
        }),
      ),
    );
    const account = decodeSolanaHistoryAccount(
      record(
        addresses.sourceToken,
        packTokenAccount({
          amount: 18_446_744_073_709_551_615n,
          delegatedAmount: 18_446_744_073_709_551_615n,
        }),
      ),
    );

    expect(mint).toMatchObject({
      kind: 'mint',
      address: addresses.mint,
      supply: '18446744073709551615',
      decimals: 6,
      initialized: true,
      mintAuthority: addresses.sender,
      freezeAuthority: addresses.vault,
      extensions: [],
    });
    expect(account).toMatchObject({
      kind: 'token-account',
      address: addresses.sourceToken,
      mint: addresses.mint,
      owner: addresses.sender,
      amount: '18446744073709551615',
      delegatedAmount: '18446744073709551615',
      state: 'initialized',
      delegate: null,
      closeAuthority: null,
      extensions: [],
    });
  });

  /**
   * @target decodeSolanaHistoryAccount: retain present authority keys.
   * @dependencies Token-account bytes with valid Some option tags.
   * @scenario Decode a token account with delegate and close authority keys.
   * @expected Return both supplied keys on the decoded account.
   */
  it('preserves Some delegate and close-authority keys', () => {
    const account = decodeSolanaHistoryAccount(
      record(
        addresses.vaultToken,
        packTokenAccount({
          owner: addresses.vault,
          delegate: addresses.sender,
          closeAuthority: addresses.sponsor,
        }),
      ),
    );

    expect(account).toMatchObject({
      delegate: addresses.sender,
      closeAuthority: addresses.sponsor,
    });
  });

  /**
   * @target decodeSolanaHistoryAccount: accept None options.
   * @dependencies Mint and token layouts with ignored option payload bytes.
   * @scenario Decode None authority options whose unused bytes are nonzero.
   * @expected Return null authorities while accepting the valid records.
   */
  it('accepts None options with ignored nonzero payload bytes', () => {
    const mint = decodeSolanaHistoryAccount(record(addresses.mint, packMint()));
    const account = decodeSolanaHistoryAccount(
      record(addresses.sourceToken, packTokenAccount({ nativeReserve: 123n })),
    );
    expect(mint).toMatchObject({ mintAuthority: null, freezeAuthority: null });
    expect(account).toMatchObject({ delegate: null, closeAuthority: null });
  });

  /**
   * @target decodeSolanaHistoryAccount: reject malformed record fields.
   * @dependencies Invalid records and stable decoder error codes.
   * @scenario Vary record, owner, executable, encoding, size, and key fields.
   * @expected Throw the corresponding stable code for every malformed record.
   */
  it.each([
    ['missing record', undefined, 'RECORD'],
    [
      'missing address',
      { ...record(addresses.mint, packMint()), address: undefined },
      'ADDRESS',
    ],
    [
      'coerced address',
      { ...record(addresses.mint, packMint()), address: 12 },
      'ADDRESS',
    ],
    [
      'missing owner',
      { ...record(addresses.mint, packMint()), programOwner: undefined },
      'PROGRAM_OWNER',
    ],
    [
      'wrong program',
      {
        ...record(addresses.mint, packMint()),
        programOwner: addresses.sponsor,
      },
      'PROGRAM_OWNER',
    ],
    [
      'executable account',
      { ...record(addresses.mint, packMint()), executable: true },
      'EXECUTABLE',
    ],
    [
      'missing executable field',
      { ...record(addresses.mint, packMint()), executable: undefined },
      'EXECUTABLE',
    ],
    [
      'missing data',
      { ...record(addresses.mint, packMint()), data: undefined },
      'DATA_ENCODING',
    ],
    [
      'coerced data',
      { ...record(addresses.mint, packMint()), data: 82 },
      'DATA_ENCODING',
    ],
    [
      'oversized data before decode',
      record(addresses.mint, Buffer.alloc(168)),
      'DATA_ENCODING',
    ],
    [
      'forbidden base64 alphabet',
      {
        ...record(addresses.mint, packMint()),
        data: `${record(addresses.mint, packMint()).data}!`,
      },
      'DATA_ENCODING',
    ],
    [
      'base64 whitespace',
      {
        ...record(addresses.mint, packMint()),
        data: `${record(addresses.mint, packMint()).data} `,
      },
      'DATA_ENCODING',
    ],
    [
      'noncanonical base64',
      {
        ...record(addresses.mint, packMint()),
        data: noncanonicalBase64(record(addresses.mint, packMint()).data),
      },
      'DATA_ENCODING',
    ],
    [
      'mint length mismatch',
      record(addresses.mint, Buffer.alloc(81)),
      'LAYOUT',
    ],
    [
      'token-account length mismatch',
      record(addresses.sourceToken, Buffer.alloc(164)),
      'LAYOUT',
    ],
    [
      'malformed key',
      { ...record(addresses.mint, packMint()), address: '0' },
      'ADDRESS',
    ],
  ])('rejects %s with a stable decoder code', (_name, value, code) => {
    expect(decodeErrorCode(value)).toBe(code);
  });

  /**
   * @target decodeSolanaHistoryAccount: validate mint COption tags.
   * @dependencies Mint authority and freeze-authority tag offsets.
   * @scenario Set invalid low and high-byte tags for both mint options.
   * @expected Reject each invalid tag with OPTION_TAG.
   */
  it.each([
    ['mint authority low tag', 0, 2],
    ['mint authority high-byte None tag', 0, 0x100],
    ['mint authority high-byte Some tag', 0, 0x101],
    ['freeze authority low tag', 46, 2],
    ['freeze authority high-byte None tag', 46, 0x100],
    ['freeze authority high-byte Some tag', 46, 0x101],
  ])('rejects invalid %s COption tags independently', (_name, offset, tag) => {
    const bytes = packMint();
    bytes.writeUInt32LE(tag as number, offset as number);
    expect(decodeErrorCode(record(addresses.mint, bytes))).toBe('OPTION_TAG');
  });

  /**
   * @target decodeSolanaHistoryAccount: validate token COption tags.
   * @dependencies Delegate, native-reserve, and close-authority offsets.
   * @scenario Set invalid low and high-byte tags for each token option.
   * @expected Reject each invalid tag with OPTION_TAG.
   */
  it.each([
    ['delegate low tag', 72, 2],
    ['delegate high-byte None tag', 72, 0x100],
    ['delegate high-byte Some tag', 72, 0x101],
    ['native reserve low tag', 109, 2],
    ['native reserve high-byte None tag', 109, 0x100],
    ['native reserve high-byte Some tag', 109, 0x101],
    ['close authority low tag', 129, 2],
    ['close authority high-byte None tag', 129, 0x100],
    ['close authority high-byte Some tag', 129, 0x101],
  ])('rejects invalid %s COption tags independently', (_name, offset, tag) => {
    const bytes = packTokenAccount();
    bytes.writeUInt32LE(tag as number, offset as number);
    expect(decodeErrorCode(record(addresses.sourceToken, bytes))).toBe(
      'OPTION_TAG',
    );
  });

  /**
   * @target decodeSolanaHistoryAccount: validate mint initialization state.
   * @dependencies Mint initialization byte and stable decoder error codes.
   * @scenario Decode a non-boolean initialization value and an unset value.
   * @expected Reject them with BOOLEAN and MINT_UNINITIALIZED respectively.
   */
  it('validates mint initialization as a boolean and requires initialized state', () => {
    expect(
      decodeErrorCode(record(addresses.mint, packMint({ initialized: 2 }))),
    ).toBe('BOOLEAN');
    expect(
      decodeErrorCode(record(addresses.mint, packMint({ initialized: 0 }))),
    ).toBe('MINT_UNINITIALIZED');
  });

  /**
   * @target decodeSolanaHistoryAccount: map token-account state tags.
   * @dependencies Token-account state byte and its three defined values.
   * @scenario Decode uninitialized, initialized, and frozen account states.
   * @expected Preserve each state as its corresponding decoded label.
   */
  it.each([
    [0, 'uninitialized'],
    [1, 'initialized'],
    [2, 'frozen'],
  ])('preserves token-account state tag %i', (tag, state) => {
    const account = decodeSolanaHistoryAccount(
      record(addresses.sourceToken, packTokenAccount({ state: tag })),
    );
    expect(account).toMatchObject({ state });
  });

  /**
   * @target decodeSolanaHistoryAccount: reject unsupported token states.
   * @dependencies Token-account state and native-reserve option fields.
   * @scenario Decode an unknown state and a native reserve in this profile.
   * @expected Reject them with ACCOUNT_STATE and NATIVE_RESERVE_UNSUPPORTED.
   */
  it('rejects unknown account states and native reserves in the non-wSOL profile', () => {
    expect(
      decodeErrorCode(
        record(addresses.sourceToken, packTokenAccount({ state: 3 })),
      ),
    ).toBe('ACCOUNT_STATE');
    expect(
      decodeErrorCode(
        record(
          addresses.sourceToken,
          packTokenAccount({ nativeTag: 1, nativeReserve: 1n }),
        ),
      ),
    ).toBe('NATIVE_RESERVE_UNSUPPORTED');
  });
});
