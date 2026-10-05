import {
  decodeSolanaAddress,
  SOLANA_TOKEN_PROGRAM_ID,
  validateSolanaAddress,
} from '@rosen-bridge/address-codec-solana';

const MINT_LENGTH = 82;
const TOKEN_ACCOUNT_LENGTH = 165;

type RecordValue = Record<string, unknown>;

export type SolanaDecodedHistoryAccount =
  | SolanaDecodedMintAccount
  | SolanaDecodedTokenAccount;

export interface SolanaDecodedMintAccount {
  kind: 'mint';
  address: string;
  programOwner: typeof SOLANA_TOKEN_PROGRAM_ID;
  mintAuthority: string | null;
  supply: string;
  decimals: number;
  initialized: true;
  freezeAuthority: string | null;
  extensions: [];
}

export interface SolanaDecodedTokenAccount {
  kind: 'token-account';
  address: string;
  programOwner: typeof SOLANA_TOKEN_PROGRAM_ID;
  mint: string;
  owner: string;
  amount: string;
  delegate: string | null;
  state: 'uninitialized' | 'initialized' | 'frozen';
  nativeReserve: null;
  delegatedAmount: string;
  closeAuthority: string | null;
  extensions: [];
}

export class SolanaHistoryAccountDecodeError extends Error {
  /** Creates the typed error used when an account record cannot be decoded. */
  constructor(readonly code: string) {
    super(`SolanaHistoryAccountDecodeError: ${code}`);
    this.name = 'SolanaHistoryAccountDecodeError';
  }
}

/** Throws the decoder's typed error for a rejected account value. */
const fail = (code: string): never => {
  throw new SolanaHistoryAccountDecodeError(code);
};

/** Narrows a non-null, non-array object to the decoder's record shape. */
const asRecord = (value: unknown): RecordValue => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return fail('RECORD');
  return value as RecordValue;
};

/** Validates a string as a Solana public-key address and returns it unchanged. */
const publicKey = (value: unknown): string => {
  if (typeof value !== 'string') return fail('ADDRESS');
  try {
    validateSolanaAddress(value);
  } catch {
    return fail('ADDRESS');
  }
  return value;
};

/** Validates an RPC account record and decodes its supported base64 byte layout. */
const accountBytes = (value: unknown): { address: string; bytes: Buffer } => {
  const record = asRecord(value);
  const address = publicKey(record.address);
  if (record.programOwner !== SOLANA_TOKEN_PROGRAM_ID)
    return fail('PROGRAM_OWNER');
  if (record.executable !== false) return fail('EXECUTABLE');

  const data = record.data;
  if (typeof data !== 'string') return fail('DATA_ENCODING');
  if (
    data.length === 0 ||
    data.length > 220 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      data,
    )
  )
    return fail('DATA_ENCODING');

  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) return fail('DATA_ENCODING');
  if (bytes.length !== MINT_LENGTH && bytes.length !== TOKEN_ACCOUNT_LENGTH)
    return fail('LAYOUT');
  if (data.length !== Math.ceil(bytes.length / 3) * 4)
    return fail('DATA_ENCODING');
  return { address, bytes };
};

/** Reads an SPL account COption public-key field at the supplied byte offset. */
const cOptionKey = (bytes: Buffer, offset: number): string | null => {
  const tag = bytes.readUInt32LE(offset);
  if (tag === 0) return null;
  if (tag !== 1) return fail('OPTION_TAG');
  return encodePublicKey(bytes.subarray(offset + 4, offset + 36));
};

/** Converts one 32-byte public-key value to the address codec's Base58 form. */
const encodePublicKey = (bytes: Buffer): string => {
  try {
    return decodeSolanaAddress(bytes.toString('hex'));
  } catch {
    return fail('ADDRESS');
  }
};

/** Decode an RPC account record for the original SPL Token program.
 *
 * This validates account bytes and shape only. It does not authenticate that
 * the record belongs to a transaction history, slot, or canonical chain.
 */
export const decodeSolanaHistoryAccount = (
  value: unknown,
): SolanaDecodedHistoryAccount => {
  const { address, bytes } = accountBytes(value);
  if (bytes.length === MINT_LENGTH) {
    const mintAuthority = cOptionKey(bytes, 0);
    const supply = bytes.readBigUInt64LE(36).toString();
    const decimals = bytes[44];
    const initialized = bytes[45];
    const freezeAuthority = cOptionKey(bytes, 46);
    if (initialized !== 0 && initialized !== 1) return fail('BOOLEAN');
    if (initialized === 0) return fail('MINT_UNINITIALIZED');
    return {
      kind: 'mint',
      address,
      programOwner: SOLANA_TOKEN_PROGRAM_ID,
      mintAuthority,
      supply,
      decimals,
      initialized: true,
      freezeAuthority,
      extensions: [],
    };
  }
  if (bytes.length !== TOKEN_ACCOUNT_LENGTH) return fail('LAYOUT');

  const mint = encodePublicKey(bytes.subarray(0, 32));
  const owner = encodePublicKey(bytes.subarray(32, 64));
  const amount = bytes.readBigUInt64LE(64).toString();
  const delegate = cOptionKey(bytes, 72);
  const stateTag = bytes[108];
  const state =
    stateTag === 0
      ? 'uninitialized'
      : stateTag === 1
        ? 'initialized'
        : stateTag === 2
          ? 'frozen'
          : undefined;
  if (state === undefined) return fail('ACCOUNT_STATE');

  const nativeTag = bytes.readUInt32LE(109);
  if (nativeTag !== 0 && nativeTag !== 1) return fail('OPTION_TAG');
  if (nativeTag === 1) return fail('NATIVE_RESERVE_UNSUPPORTED');
  const delegatedAmount = bytes.readBigUInt64LE(121).toString();
  const closeAuthority = cOptionKey(bytes, 129);
  return {
    kind: 'token-account',
    address,
    programOwner: SOLANA_TOKEN_PROGRAM_ID,
    mint,
    owner,
    amount,
    delegate,
    state,
    nativeReserve: null,
    delegatedAmount,
    closeAuthority,
    extensions: [],
  };
};
