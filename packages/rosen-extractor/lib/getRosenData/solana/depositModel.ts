import bs58 from 'bs58';

import {
  ERGO_SIGNED_AMOUNT_MAX,
  SOLANA_SYSTEM_PROGRAM_ID,
  SOLANA_TOKEN_2022_PROGRAM_ID,
  SOLANA_TOKEN_PROGRAM_ID,
  SOLANA_U64_MAX,
  SolanaAmountConversionError,
  solanaToErgoUnits,
} from '@rosen-bridge/address-codec-solana';

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const WSOL_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP',
]);

type RecordValue = Record<string, unknown>;

export interface SolanaDepositAssetPolicy {
  program: string;
  sourceDecimals: number;
  destinationDecimals: number;
  destinationTokenId: string;
  minAmount: string;
  maxAmount: string;
  networkFee: string;
  bridgeFee: string;
  vaultTokenAccount?: string;
}

export interface SolanaDepositConfig {
  clusterGenesisHash: string;
  destinationNetwork: string;
  vaultOwner: string;
  assets: Record<string, SolanaDepositAssetPolicy>;
}

export interface SolanaDepositResult {
  sourceChain: 'solana';
  clusterGenesisHash: string;
  sourceTxId: string;
  sourceSlot: number;
  sourceBlockhash: string;
  sourceAsset: string;
  tokenProgram: string;
  sourceAmount: string;
  fromAddress: string;
  toChain: 'ergo';
  toAddress: string;
  destinationTokenId: string;
  amount: string;
  networkFee: string;
  bridgeFee: string;
  recipientAmount: string;
}

export type ErgoAddressValidator = (
  address: string,
  network: string,
) => boolean;

export class SolanaDepositError extends Error {
  /** Creates a deposit-model error with its rejection code. */
  constructor(readonly code: string) {
    super(`SolanaDepositError: ${code}`);
    this.name = 'SolanaDepositError';
  }
}

/** Throws the typed deposit error for a rejected input or policy check. */
const fail = (code: string): never => {
  throw new SolanaDepositError(code);
};

/** Rejects a false validation condition with its corresponding error code. */
const requireThat = (condition: boolean, code: string): void => {
  if (!condition) fail(code);
};

/** Narrows a non-null, non-array object to a record or rejects it. */
const asRecord = (value: unknown, code: string): RecordValue => {
  requireThat(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    code,
  );
  return value as RecordValue;
};

/** Narrows an unknown value to an array or rejects it. */
const asArray = (value: unknown, code: string): unknown[] => {
  requireThat(Array.isArray(value), code);
  return value as unknown[];
};

/** Validates that a number is a safe integer within the inclusive bounds. */
const safeInt = (
  value: unknown,
  minimum: number,
  maximum: number,
  code: string,
): number => {
  requireThat(
    typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= minimum &&
      value <= maximum,
    code,
  );
  return value as number;
};

/** Decodes canonical Base58 data with optional exact and maximum byte limits. */
const base58Decode = (
  value: unknown,
  size?: number,
  maximumBytes = 768,
): Buffer => {
  requireThat(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= Math.ceil(maximumBytes * 1.38),
    'BASE58_ENCODING',
  );
  try {
    const bytes = Buffer.from(bs58.decode(value as string));
    requireThat(
      bytes.length <= maximumBytes &&
        (size === undefined || bytes.length === size) &&
        bs58.encode(bytes) === value,
      'BASE58_ENCODING',
    );
    return bytes;
  } catch (error) {
    if (error instanceof SolanaDepositError) throw error;
    return fail('BASE58_ENCODING');
  }
};

/** Validates a value as a canonical 32-byte Base58 public key. */
const key = (value: unknown): string => {
  base58Decode(value, 32, 32);
  return value as string;
};

/** Parses a canonical unsigned decimal string within the supplied maximum. */
const uint = (value: unknown, maximum = SOLANA_U64_MAX): bigint => {
  requireThat(
    typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value),
    'INTEGER_ENCODING',
  );
  const result = BigInt(value as string);
  requireThat(result <= maximum, 'INTEGER_RANGE');
  return result;
};

interface ResolvedInstruction {
  program: string;
  accounts: number[];
  data: Buffer;
}

interface ResolvedMessage {
  keys: string[];
  writable: (index: number) => boolean;
  signer: (index: number) => boolean;
  instructions: ResolvedInstruction[];
  sourceTxId: string;
}

/** Resolves message keys, signer and writable indexes, and instruction data. */
const resolveMessage = (input: RecordValue): ResolvedMessage => {
  const version = input.version;
  requireThat(version === 'legacy' || version === 0, 'TX_VERSION');
  const transaction = asRecord(input.transaction, 'TRANSACTION');
  const message = asRecord(transaction.message, 'MESSAGE');
  const accountKeys = asArray(message.accountKeys, 'ACCOUNT_KEYS');
  requireThat(accountKeys.length <= 256, 'ACCOUNT_KEYS');
  const staticKeys = accountKeys.map(key);
  const header = asRecord(message.header, 'HEADER');
  const required = safeInt(
    header.numRequiredSignatures,
    1,
    staticKeys.length,
    'HEADER',
  );
  const readonlySigned = safeInt(
    header.numReadonlySignedAccounts,
    0,
    required,
    'HEADER',
  );
  const readonlyUnsigned = safeInt(
    header.numReadonlyUnsignedAccounts,
    0,
    staticKeys.length - required,
    'HEADER',
  );
  const signatures = asArray(transaction.signatures, 'SIGNATURES');
  requireThat(signatures.length === required, 'SIGNATURES');
  signatures.forEach((signature) => base58Decode(signature, 64, 64));
  const sourceTxId = signatures[0];
  requireThat(typeof sourceTxId === 'string', 'SIGNATURES');
  base58Decode(message.recentBlockhash, 32, 32);

  const meta = asRecord(input.meta, 'TRANSACTION_FAILED');
  const loadedAddresses = asRecord(meta.loadedAddresses, 'LOADED_ADDRESSES');
  const loadedWritable = asArray(
    loadedAddresses.writable,
    'LOADED_ADDRESSES',
  ).map(key);
  const loadedReadonly = asArray(
    loadedAddresses.readonly,
    'LOADED_ADDRESSES',
  ).map(key);

  if (version === 'legacy') {
    const lookups = message.addressTableLookups;
    requireThat(
      loadedWritable.length === 0 &&
        loadedReadonly.length === 0 &&
        (lookups === undefined ||
          (Array.isArray(lookups) && lookups.length === 0)),
      'LEGACY_LOOKUPS',
    );
  } else {
    const lookups = asArray(message.addressTableLookups, 'LOOKUP_METADATA');
    let writableCount = 0;
    let readonlyCount = 0;
    for (const item of lookups) {
      const lookup = asRecord(item, 'LOOKUP_METADATA');
      key(lookup.accountKey);
      const writableIndexes = asArray(
        lookup.writableIndexes,
        'LOOKUP_METADATA',
      );
      const readonlyIndexes = asArray(
        lookup.readonlyIndexes,
        'LOOKUP_METADATA',
      );
      writableIndexes.forEach((index) =>
        safeInt(index, 0, 255, 'LOOKUP_METADATA'),
      );
      readonlyIndexes.forEach((index) =>
        safeInt(index, 0, 255, 'LOOKUP_METADATA'),
      );
      writableCount += writableIndexes.length;
      readonlyCount += readonlyIndexes.length;
    }
    requireThat(
      writableCount === loadedWritable.length &&
        readonlyCount === loadedReadonly.length,
      'LOOKUP_METADATA',
    );
  }

  const keys = [...staticKeys, ...loadedWritable, ...loadedReadonly];
  requireThat(
    keys.length <= 256 && new Set(keys).size === keys.length,
    'ACCOUNT_KEYS',
  );
  /** Reports writability from static headers or loaded-address position. */
  const writable = (index: number): boolean =>
    index < staticKeys.length
      ? index < required
        ? index < required - readonlySigned
        : index < staticKeys.length - readonlyUnsigned
      : index < staticKeys.length + loadedWritable.length;
  /** Reports whether an index is among the required static message signers. */
  const signer = (index: number): boolean => index < required;
  const instructions = asArray(message.instructions, 'INSTRUCTION_COUNT');
  requireThat(instructions.length === 2, 'INSTRUCTION_COUNT');
  const resolved = instructions.map((value) => {
    const instruction = asRecord(value, 'INSTRUCTION');
    const programIdIndex = safeInt(
      instruction.programIdIndex,
      0,
      keys.length - 1,
      'ACCOUNT_INDEX',
    );
    const accounts = asArray(instruction.accounts, 'INSTRUCTION_ACCOUNTS');
    requireThat(accounts.length <= 4, 'INSTRUCTION_ACCOUNTS');
    const resolvedAccounts = accounts.map((index) =>
      safeInt(index, 0, keys.length - 1, 'ACCOUNT_INDEX'),
    );
    return {
      program: keys[programIdIndex],
      accounts: resolvedAccounts,
      data: base58Decode(instruction.data),
    };
  });

  return {
    keys,
    writable,
    signer,
    instructions: resolved,
    sourceTxId: sourceTxId as string,
  };
};

/** Parses the UTF-8 Memo payload and validates its ordered payment fields. */
const parseMemo = (
  instruction: ResolvedInstruction,
  payment: {
    asset: string;
    amount: bigint;
    authorityIndex: number;
  },
  input: RecordValue,
  validateErgoAddress: ErgoAddressValidator,
): RecordValue => {
  requireThat(
    instruction.program === MEMO_PROGRAM_ID &&
      instruction.accounts.length === 1 &&
      instruction.accounts[0] === payment.authorityIndex,
    'MEMO_AUTHORITY',
  );
  let text: string;
  let memo: unknown;
  try {
    text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(instruction.data);
    memo = JSON.parse(text);
  } catch {
    return fail('MEMO_ENCODING');
  }
  const fields = [
    'v',
    'toChain',
    'toAddress',
    'asset',
    'amount',
    'networkFee',
    'bridgeFee',
  ];
  requireThat(
    typeof memo === 'object' &&
      memo !== null &&
      !Array.isArray(memo) &&
      Object.keys(memo).length === fields.length &&
      fields.every((field, index) => Object.keys(memo)[index] === field) &&
      JSON.stringify(memo) === text,
    'MEMO_CANONICAL',
  );
  const parsed = memo as RecordValue;
  requireThat(
    parsed.v === 1 && parsed.toChain === 'ergo',
    'MEMO_VERSION_CHAIN',
  );
  requireThat(
    typeof parsed.toAddress === 'string' &&
      parsed.toAddress.length > 0 &&
      parsed.toAddress.length <= 256 &&
      /^[\x21-\x7e]+$/.test(parsed.toAddress) &&
      validateErgoAddress(
        parsed.toAddress,
        String(input.destinationNetwork),
      ) === true,
    'DESTINATION',
  );
  requireThat(
    parsed.asset === payment.asset && uint(parsed.amount) === payment.amount,
    'MEMO_PAYMENT',
  );
  return parsed;
};

/** Returns the unique token-balance metadata entry for an account index. */
const tokenBalance = (balances: unknown, index: number): RecordValue => {
  const entries = asArray(balances, 'TOKEN_METADATA');
  const matches = entries.filter((entry) => {
    const value = asRecord(entry, 'TOKEN_METADATA');
    return value.accountIndex === index;
  });
  requireThat(matches.length === 1, 'TOKEN_METADATA');
  return asRecord(matches[0], 'TOKEN_METADATA');
};

/** Checks a decoded token-account state against expected identity and status. */
const checkTokenState = (
  state: unknown,
  address: string,
  owner: string,
  mint: string,
): bigint => {
  const account = asRecord(state, 'TOKEN_STATE');
  requireThat(
    account.address === address &&
      account.programOwner === SOLANA_TOKEN_PROGRAM_ID &&
      account.mint === mint &&
      account.owner === owner &&
      account.state === 'initialized' &&
      Array.isArray(account.extensions) &&
      account.extensions.length === 0,
    'TOKEN_STATE',
  );
  return uint(account.amount);
};

/** Compares token-balance metadata and decimals with the decoded account. */
const checkTokenBalance = (
  balance: RecordValue,
  state: RecordValue,
  decimals: number,
): void => {
  const uiAmount = asRecord(balance.uiTokenAmount, 'TOKEN_METADATA');
  requireThat(
    balance.programId === SOLANA_TOKEN_PROGRAM_ID &&
      balance.mint === state.mint &&
      balance.owner === state.owner &&
      uiAmount.decimals === decimals &&
      uint(uiAmount.amount) === uint(state.amount),
    'TOKEN_METADATA',
  );
};

/** Cross-checks supplied SPL history snapshots and balance metadata for a payment. */
const checkSplHistory = (
  input: RecordValue,
  payment: {
    asset: string;
    amount: bigint;
    source: string;
    sourceIndex: number;
    destination: string;
    destinationIndex: number;
    authority: string;
  },
  policy: SolanaDepositAssetPolicy,
  clusterGenesisHash: string,
  vaultOwner: string,
): void => {
  const history = asRecord(input.history, 'HISTORY_BINDING');
  const transaction = asRecord(input.transaction, 'TRANSACTION');
  const signatures = asArray(transaction.signatures, 'SIGNATURES');
  requireThat(
    history.slot === input.slot &&
      history.sourceTxId === signatures[0] &&
      history.clusterGenesisHash === clusterGenesisHash,
    'HISTORY_BINDING',
  );
  const mint = asRecord(history.mint, 'MINT_HISTORY');
  const source = asRecord(history.source, 'TOKEN_STATE');
  const vault = asRecord(history.vault, 'TOKEN_STATE');
  requireThat(
    mint.address === payment.asset &&
      (['pre', 'post'] as const).every((phase) => {
        const state = asRecord(mint[phase], 'MINT_HISTORY');
        return (
          state.programOwner === SOLANA_TOKEN_PROGRAM_ID &&
          state.decimals === policy.sourceDecimals &&
          Array.isArray(state.extensions) &&
          state.extensions.length === 0
        );
      }),
    'MINT_HISTORY',
  );
  const sourceBefore = asRecord(source.pre, 'TOKEN_STATE');
  const sourceAfter = asRecord(source.post, 'TOKEN_STATE');
  const vaultBefore = asRecord(vault.pre, 'TOKEN_STATE');
  const vaultAfter = asRecord(vault.post, 'TOKEN_STATE');
  const sourceAmountBefore = checkTokenState(
    sourceBefore,
    payment.source,
    payment.authority,
    payment.asset,
  );
  const sourceAmountAfter = checkTokenState(
    sourceAfter,
    payment.source,
    payment.authority,
    payment.asset,
  );
  const vaultAmountBefore = checkTokenState(
    vaultBefore,
    payment.destination,
    vaultOwner,
    payment.asset,
  );
  const vaultAmountAfter = checkTokenState(
    vaultAfter,
    payment.destination,
    vaultOwner,
    payment.asset,
  );
  requireThat(
    (['pre', 'post'] as const).every((phase) => {
      const account = phase === 'pre' ? vaultBefore : vaultAfter;
      return account.delegate === null && account.closeAuthority === null;
    }),
    'VAULT_AUTHORITY',
  );
  requireThat(
    sourceAmountBefore - sourceAmountAfter === payment.amount &&
      vaultAmountAfter - vaultAmountBefore === payment.amount,
    'TOKEN_DELTA',
  );
  const meta = asRecord(input.meta, 'TOKEN_METADATA');
  for (const [phase, field] of [
    ['pre', 'preTokenBalances'],
    ['post', 'postTokenBalances'],
  ] as const) {
    const balances = meta[field];
    const sourceState = phase === 'pre' ? sourceBefore : sourceAfter;
    const vaultState = phase === 'pre' ? vaultBefore : vaultAfter;
    checkTokenBalance(
      tokenBalance(balances, payment.sourceIndex),
      sourceState,
      policy.sourceDecimals,
    );
    checkTokenBalance(
      tokenBalance(balances, payment.destinationIndex),
      vaultState,
      policy.sourceDecimals,
    );
  }
};

/** Maps a Solana amount to Ergo units and translates known conversion faults. */
const toErgoUnits = (
  amount: bigint,
  asset: SolanaDepositAssetPolicy,
): bigint => {
  try {
    return solanaToErgoUnits(
      amount,
      asset.sourceDecimals,
      asset.destinationDecimals,
    );
  } catch (error) {
    if (error instanceof SolanaAmountConversionError) {
      if (error.code === 'MAPPING_DUST') return fail('MAPPING_DUST');
      if (error.code === 'ERGO_SIGNED_RANGE') return fail('ERGO_RANGE');
      if (error.code === 'DECIMALS_RANGE') return fail('DECIMALS');
      return fail('INTEGER_RANGE');
    }
    throw error;
  }
};

/** Validates a supplied transaction projection and maps it to a Rosen deposit result.
 * @param value Transaction, metadata, and associated supplied history projection
 * @param config Cluster, vault, asset, and fee policy for the deposit
 * @param validateErgoAddress Destination-address validator for the configured network
 * @returns The validated Solana-to-Ergo deposit fields in canonical decimal strings
 */
export const extractSolanaDeposit = (
  value: unknown,
  config: SolanaDepositConfig,
  validateErgoAddress: ErgoAddressValidator,
): SolanaDepositResult => {
  requireThat(
    typeof validateErgoAddress === 'function',
    'DESTINATION_VALIDATOR',
  );
  const input = asRecord(value, 'INCOMPLETE_INPUT');
  key(config.clusterGenesisHash);
  key(config.vaultOwner);
  requireThat(
    input.clusterGenesisHash === config.clusterGenesisHash,
    'CLUSTER',
  );
  requireThat(
    input.destinationNetwork === config.destinationNetwork,
    'DESTINATION_NETWORK',
  );
  requireThat(input.commitment === 'finalized', 'FINALITY');
  const slot = safeInt(input.slot, 0, Number.MAX_SAFE_INTEGER, 'SLOT');
  const blockhash = key(input.blockhash);
  const meta = asRecord(input.meta, 'TRANSACTION_FAILED');
  requireThat(meta.err === null, 'TRANSACTION_FAILED');
  const inner = asArray(meta.innerInstructions, 'CPI_OR_MISSING_TRACE');
  requireThat(
    inner.every((group) => {
      const value = asRecord(group, 'CPI_OR_MISSING_TRACE');
      return (
        Array.isArray(value.instructions) && value.instructions.length === 0
      );
    }),
    'CPI_OR_MISSING_TRACE',
  );

  const message = resolveMessage(input);
  const [transfer, memoInstruction] = message.instructions;
  requireThat(
    transfer.program !== SOLANA_TOKEN_2022_PROGRAM_ID,
    'TOKEN_2022_DENIED',
  );
  const sourceIndex = transfer.accounts[0];
  const payment: {
    asset: string;
    amount: bigint;
    sourceIndex: number;
    destinationIndex: number;
    authorityIndex: number;
    decimals: number;
    source: string;
    destination: string;
    authority: string;
  } = {
    asset: '',
    amount: 0n,
    sourceIndex,
    destinationIndex: -1,
    authorityIndex: -1,
    decimals: 0,
    source: '',
    destination: '',
    authority: '',
  };
  if (transfer.program === SOLANA_SYSTEM_PROGRAM_ID) {
    requireThat(
      transfer.accounts.length === 2 &&
        transfer.data.length === 12 &&
        transfer.data.readUInt32LE(0) === 2,
      'SYSTEM_TRANSFER',
    );
    Object.assign(payment, {
      asset: 'SOL',
      decimals: 9,
      amount: transfer.data.readBigUInt64LE(4),
      destinationIndex: transfer.accounts[1],
      authorityIndex: transfer.accounts[0],
    });
  } else if (transfer.program === SOLANA_TOKEN_PROGRAM_ID) {
    requireThat(
      transfer.accounts.length === 4 &&
        transfer.data.length === 10 &&
        transfer.data[0] === 12,
      'TOKEN_TRANSFER_CHECKED',
    );
    Object.assign(payment, {
      asset: message.keys[transfer.accounts[1]],
      amount: transfer.data.readBigUInt64LE(1),
      decimals: transfer.data[9],
      destinationIndex: transfer.accounts[2],
      authorityIndex: transfer.accounts[3],
    });
    requireThat(!WSOL_MINTS.has(payment.asset), 'WSOL_DENIED');
  } else {
    return fail('PROGRAM_DENIED');
  }
  payment.source = message.keys[payment.sourceIndex];
  payment.destination = message.keys[payment.destinationIndex];
  payment.authority = message.keys[payment.authorityIndex];
  requireThat(payment.source !== payment.destination, 'SELF_TRANSFER');
  requireThat(payment.amount > 0n, 'ZERO_AMOUNT');
  requireThat(
    message.writable(payment.sourceIndex) &&
      message.writable(payment.destinationIndex),
    'PAYMENT_WRITABLE',
  );
  requireThat(message.signer(payment.authorityIndex), 'PAYMENT_SIGNER');
  const assets = asRecord(config.assets, 'ASSET_POLICY');
  requireThat(Object.hasOwn(assets, payment.asset), 'UNSUPPORTED_ASSET');
  const policy = asRecord(
    assets[payment.asset],
    'ASSET_POLICY',
  ) as unknown as SolanaDepositAssetPolicy;
  requireThat(
    policy.program === transfer.program &&
      policy.sourceDecimals === payment.decimals,
    'ASSET_POLICY',
  );
  requireThat(
    typeof policy.destinationTokenId === 'string' &&
      /^[0-9a-f]{64}$/.test(policy.destinationTokenId),
    'DESTINATION_TOKEN_ID',
  );
  requireThat(
    payment.destination ===
      (payment.asset === 'SOL' ? config.vaultOwner : policy.vaultTokenAccount),
    'VAULT_DESTINATION',
  );
  requireThat(payment.authority !== config.vaultOwner, 'VAULT_AS_SENDER');
  const minimum = uint(policy.minAmount);
  const maximum = uint(policy.maxAmount);
  requireThat(
    payment.amount >= minimum && payment.amount <= maximum,
    'AMOUNT_POLICY',
  );
  const memo = parseMemo(memoInstruction, payment, input, validateErgoAddress);
  const networkFee = uint(memo.networkFee);
  const bridgeFee = uint(memo.bridgeFee);
  requireThat(
    networkFee === uint(policy.networkFee) &&
      bridgeFee === uint(policy.bridgeFee),
    'FEE_POLICY',
  );
  requireThat(networkFee + bridgeFee < payment.amount, 'FEE_EXHAUSTS_AMOUNT');

  if (payment.asset === 'SOL') {
    const before = asArray(meta.preBalances, 'SOL_METADATA');
    const after = asArray(meta.postBalances, 'SOL_METADATA');
    requireThat(
      before.length === message.keys.length &&
        after.length === message.keys.length,
      'SOL_METADATA',
    );
    before.forEach((amount) => uint(amount));
    after.forEach((amount) => uint(amount));
    const fee = uint(meta.fee);
    requireThat(
      uint(after[payment.destinationIndex]) -
        uint(before[payment.destinationIndex]) ===
        payment.amount &&
        uint(before[payment.sourceIndex]) - uint(after[payment.sourceIndex]) ===
          payment.amount + (payment.sourceIndex === 0 ? fee : 0n),
      'SOL_DELTA',
    );
  } else {
    checkSplHistory(
      input,
      {
        asset: payment.asset,
        amount: payment.amount,
        source: payment.source,
        sourceIndex: payment.sourceIndex,
        destination: payment.destination,
        destinationIndex: payment.destinationIndex,
        authority: payment.authority,
      },
      policy,
      config.clusterGenesisHash,
      config.vaultOwner,
    );
  }

  const amount = toErgoUnits(payment.amount, policy);
  const mappedNetworkFee = toErgoUnits(networkFee, policy);
  const mappedBridgeFee = toErgoUnits(bridgeFee, policy);
  requireThat(amount <= ERGO_SIGNED_AMOUNT_MAX, 'ERGO_RANGE');
  return Object.freeze({
    sourceChain: 'solana',
    clusterGenesisHash: config.clusterGenesisHash,
    sourceTxId: message.sourceTxId,
    sourceSlot: slot,
    sourceBlockhash: blockhash,
    sourceAsset: payment.asset,
    tokenProgram: transfer.program,
    sourceAmount: payment.amount.toString(),
    fromAddress: payment.authority,
    toChain: 'ergo',
    toAddress: memo.toAddress as string,
    destinationTokenId: policy.destinationTokenId,
    amount: amount.toString(),
    networkFee: mappedNetworkFee.toString(),
    bridgeFee: mappedBridgeFee.toString(),
    recipientAmount: (amount - mappedNetworkFee - mappedBridgeFee).toString(),
  });
};
