import bs58 from 'bs58';
import { Address, NetworkPrefix } from 'ergo-lib-wasm-nodejs';

import { AbstractLogger } from '@rosen-bridge/abstract-logger';
import {
  SOLANA_CHAIN,
  SOLANA_NATIVE_ASSET,
  SOLANA_SYSTEM_PROGRAM_ID,
  SOLANA_TOKEN_PROGRAM_ID,
  solanaToErgoUnits,
} from '@rosen-bridge/address-codec-solana';
import { AddressManager } from '@rosen-bridge/address-manager';
import { JsonBigIntFactory } from '@rosen-bridge/json-bigint';
import { RosenTokens, TokenMap } from '@rosen-bridge/tokens';

import AbstractRosenDataExtractor from '../abstract/abstractRosenDataExtractor';
import { RosenData } from '../abstract/types';
import { ERGO_CHAIN } from '../const';
import { SOLANA_NATIVE_TOKEN } from './constants';
import {
  ErgoAddressValidator,
  SolanaDepositAssetPolicy,
  SolanaDepositConfig,
  SolanaDepositError,
  SolanaDepositResult,
  extractSolanaDeposit,
} from './depositModel';

export interface SolanaDepositContext {
  clusterGenesisHash: string;
  sourceTxId: string;
  sourceSlot: number;
  sourceBlockhash: string;
}

export type SolanaRosenExtractionOutcome =
  | {
      type: 'deposit';
      data: RosenData;
      context: SolanaDepositContext;
    }
  | { type: 'not-deposit'; reason: string }
  | { type: 'unavailable'; reason: string };

export interface SolanaBlockProjectionContext {
  slot: number;
  blockhash: string;
}

export type SolanaRosenBlockExtractionOutcome =
  | {
      type: 'block';
      transactions: Array<{
        transactionIndex: number;
        signature: string;
        outcome: SolanaRosenExtractionOutcome;
      }>;
    }
  | { type: 'unavailable'; reason: string };

interface SolanaProjection {
  deposit: SolanaDepositResult;
  data: RosenData;
}

/** Narrows a non-null, non-array object to a record. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const SOLANA_MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

/**
 * Rosen v1 deposits have exactly two outer instructions: an allowed payment,
 * then the Memo program. This cheap check lets ordinary block traffic remain
 * `not-deposit` even when RPC omits metadata irrelevant to that transaction.
 */
const hasDepositInstructionPair = (value: unknown): boolean | undefined => {
  if (!isRecord(value) || !isRecord(value.transaction)) return undefined;
  const message = value.transaction.message;
  if (!isRecord(message) || !Array.isArray(message.instructions))
    return undefined;
  if (message.instructions.length !== 2) return false;
  if (!Array.isArray(message.accountKeys)) return undefined;

  const meta = isRecord(value.meta) ? value.meta : undefined;
  const loaded = isRecord(meta?.loadedAddresses)
    ? meta.loadedAddresses
    : undefined;
  const loadedKeys = [
    ...(Array.isArray(loaded?.writable) ? loaded.writable : []),
    ...(Array.isArray(loaded?.readonly) ? loaded.readonly : []),
  ];
  /** Resolves an instruction's program ID from its indexed message keys. */
  const resolveProgram = (instruction: unknown): string | undefined => {
    if (!isRecord(instruction)) return undefined;
    const index = instruction.programIdIndex;
    if (!Number.isSafeInteger(index) || (index as number) < 0) return undefined;
    const accountIndex = index as number;
    const keys = [...(message.accountKeys as unknown[]), ...loadedKeys];
    const program = keys[accountIndex];
    return typeof program === 'string' ? program : undefined;
  };
  const paymentProgram = resolveProgram(message.instructions[0]);
  const memoProgram = resolveProgram(message.instructions[1]);
  if (paymentProgram === undefined || memoProgram === undefined)
    return undefined;
  return (
    (paymentProgram === SOLANA_SYSTEM_PROGRAM_ID ||
      paymentProgram === SOLANA_TOKEN_PROGRAM_ID) &&
    memoProgram === SOLANA_MEMO_PROGRAM_ID
  );
};

/**
 * Distinguish a complete RPC observation from one whose missing history could
 * hide a deposit. Detailed semantic checks remain in the L2 deposit model.
 */
const hasCompleteTransactionEnvelope = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  const transaction = value.transaction;
  const meta = value.meta;
  if (!isRecord(transaction) || !isRecord(meta)) return false;
  const message = transaction.message;
  if (!isRecord(message)) return false;
  const loadedAddresses = meta.loadedAddresses;
  if (!isRecord(loadedAddresses)) return false;
  if (
    !Array.isArray(transaction.signatures) ||
    !Array.isArray(message.accountKeys) ||
    !isRecord(message.header) ||
    !Array.isArray(message.instructions) ||
    !Array.isArray(loadedAddresses.writable) ||
    !Array.isArray(loadedAddresses.readonly) ||
    !Object.hasOwn(meta, 'err') ||
    !Array.isArray(meta.innerInstructions)
  )
    return false;
  return meta.innerInstructions.every(
    (group) => isRecord(group) && Array.isArray(group.instructions),
  );
};

const definitelyNotDepositCodes = new Set([
  'AMOUNT_POLICY',
  'CPI_OR_MISSING_TRACE',
  'DESTINATION',
  'DESTINATION_ADDRESS',
  'FEE_EXHAUSTS_AMOUNT',
  'FEE_POLICY',
  'INSTRUCTION_COUNT',
  'MEMO_AUTHORITY',
  'MEMO_CANONICAL',
  'MEMO_ENCODING',
  'MEMO_PAYMENT',
  'MEMO_VERSION_CHAIN',
  'MAPPING_DUST',
  'PAYMENT_SIGNER',
  'PAYMENT_WRITABLE',
  'PROGRAM_DENIED',
  'SELF_TRANSFER',
  'SOL_DELTA',
  'SYSTEM_TRANSFER',
  'TOKEN_TRANSFER_CHECKED',
  'TOKEN_2022_DENIED',
  'UNSUPPORTED_ASSET',
  'VAULT_AS_SENDER',
  'VAULT_DESTINATION',
  'WSOL_DENIED',
  'ZERO_AMOUNT',
]);

/** Extracts a known deposit or error-object code, with a stable fallback. */
const errorCode = (error: unknown): string => {
  if (error instanceof SolanaDepositError) return error.code;
  if (error && typeof error === 'object' && 'code' in error)
    return String(error.code);
  return 'UNEXPECTED_ERROR';
};

export interface SolanaRosenAssetPolicy {
  minAmount: string;
  maxAmount: string;
  networkFee: string;
  bridgeFee: string;
  vaultTokenAccount?: string;
}

export interface SolanaRosenExtractorConfig {
  clusterGenesisHash: string;
  destinationNetwork: string;
  vaultOwner: string;
  assets: Record<string, SolanaRosenAssetPolicy>;
}

export interface SolanaResolvedAssetProfile {
  readonly assetId: string;
  readonly programId: string;
  readonly mint: string | null;
  readonly vaultTokenAccount: string | null;
  readonly sourceDecimals: number;
  readonly destinationDecimals: number;
  readonly destinationTokenId: string;
  readonly minAmount: string;
  readonly maxAmount: string;
  readonly networkFee: string;
  readonly bridgeFee: string;
}

export interface SolanaResolvedProfile {
  readonly genesisHash: string;
  readonly destinationChain: 'ergo';
  readonly destinationNetwork: 'mainnet' | 'testnet';
  readonly vaultOwner: string;
  readonly memoVersion: 1;
  readonly projectorVersion: string;
  readonly assets: readonly SolanaResolvedAssetProfile[];
}

/** Bumped whenever the concrete Solana projection rules change. */
export const SOLANA_PROJECTOR_VERSION = 'solana-rosen-projector-v2';

/** Checks an Ergo address by parsing and round-tripping it for the network. */
const validateErgoAddress: ErgoAddressValidator = (address, network) => {
  let parsed: Address | undefined;
  try {
    if (network === 'mainnet') {
      parsed = Address.from_mainnet_str(address);
      return parsed.to_base58(NetworkPrefix.Mainnet) === address;
    }
    if (network === 'testnet') {
      parsed = Address.from_testnet_str(address);
      return parsed.to_base58(NetworkPrefix.Testnet) === address;
    }
    return false;
  } catch {
    return false;
  } finally {
    parsed?.free();
  }
};

/** Recursively freezes an object and its enumerable child values in place. */
const deepFreeze = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value))
    return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

/** Requires a canonical Base58 encoding of a 32-byte Solana public key. */
const requirePublicKey = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 44)
    throw new Error(`Invalid Solana configuration: ${name}`);
  try {
    const decoded = bs58.decode(value);
    if (decoded.length !== 32 || bs58.encode(decoded) !== value)
      throw new Error();
  } catch {
    throw new Error(`Invalid Solana configuration: ${name}`);
  }
  return value;
};

/** Parses a canonical unsigned decimal configuration amount within u64. */
const requireAmount = (value: unknown, name: string): bigint => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value))
    throw new Error(`Invalid Solana configuration: ${name}`);
  const amount = BigInt(value);
  if (amount > BigInt('18446744073709551615'))
    throw new Error(`Invalid Solana configuration: ${name}`);
  return amount;
};

class ResolvedTokenMap extends TokenMap {
  /** Builds an isolated token map from a cloned and frozen token configuration. */
  constructor(tokenSets: RosenTokens) {
    super();
    this.tokensConfig = deepFreeze(structuredClone(tokenSets));
    this.unbridgeableTokens = [];
  }
}

interface ResolvedExtractorConfig {
  profile: SolanaRosenExtractorConfig;
  tokens: TokenMap;
  depositConfig: SolanaDepositConfig;
  descriptor: SolanaResolvedProfile;
}

/** Validates supplied asset policy against the token map and builds resolved configs. */
const resolveExtractorConfig = (
  profile: SolanaRosenExtractorConfig,
  externalTokens: TokenMap,
): ResolvedExtractorConfig => {
  if (!isRecord(profile) || !isRecord(profile.assets))
    throw new Error('Invalid Solana configuration: assets');
  requirePublicKey(profile.clusterGenesisHash, 'clusterGenesisHash');
  requirePublicKey(profile.vaultOwner, 'vaultOwner');
  if (
    profile.destinationNetwork !== 'mainnet' &&
    profile.destinationNetwork !== 'testnet'
  )
    throw new Error('Invalid Solana configuration: destinationNetwork');
  const configuredTokenSets = externalTokens.getConfig();
  const resolvedTokenSets: RosenTokens = [];
  const assets: Record<string, SolanaDepositAssetPolicy> = Object.create(null);
  const descriptorAssets: SolanaResolvedAssetProfile[] = [];
  for (const [assetId, untrustedPolicy] of Object.entries(profile.assets)) {
    const isNative = assetId === SOLANA_NATIVE_ASSET;
    if (!isNative) requirePublicKey(assetId, `assets.${assetId}.mint`);
    if (!isRecord(untrustedPolicy))
      throw new Error(`Invalid Solana configuration: assets.${assetId}`);
    const policy = untrustedPolicy as unknown as SolanaRosenAssetPolicy;
    const minimum = requireAmount(policy.minAmount, `${assetId}.minAmount`);
    const maximum = requireAmount(policy.maxAmount, `${assetId}.maxAmount`);
    const networkFee = requireAmount(
      policy.networkFee,
      `${assetId}.networkFee`,
    );
    const bridgeFee = requireAmount(policy.bridgeFee, `${assetId}.bridgeFee`);
    if (
      minimum === 0n ||
      maximum < minimum ||
      networkFee + bridgeFee >= maximum
    )
      throw new Error(
        `Invalid Solana configuration: assets.${assetId}.amounts`,
      );
    if (isNative && policy.vaultTokenAccount !== undefined)
      throw new Error(
        `Invalid Solana configuration: assets.${assetId}.vaultTokenAccount`,
      );
    const vaultTokenAccount = isNative
      ? null
      : requirePublicKey(
          policy.vaultTokenAccount,
          `assets.${assetId}.vaultTokenAccount`,
        );
    const sourceTokenId = isNative ? SOLANA_NATIVE_TOKEN : assetId;
    const matches = configuredTokenSets.filter(
      (tokenSet) => tokenSet[SOLANA_CHAIN]?.tokenId === sourceTokenId,
    );
    if (matches.length !== 1)
      throw new Error(
        `Invalid Solana configuration: assets.${assetId}.tokenMapping`,
      );
    const tokenSet = structuredClone(matches[0]);
    const sourceToken = tokenSet[SOLANA_CHAIN];
    const destinationToken = tokenSet[ERGO_CHAIN];
    if (!sourceToken || !destinationToken)
      throw new Error(
        `Invalid Solana configuration: assets.${assetId}.tokenMapping`,
      );
    const decimals = Object.values(tokenSet).map((token) => token.decimals);
    if (
      decimals.some(
        (value) => !Number.isSafeInteger(value) || value < 0 || value > 18,
      )
    )
      throw new Error(
        `Invalid Solana configuration: assets.${assetId}.decimals`,
      );
    if (!/^[0-9a-f]{64}$/.test(destinationToken.tokenId))
      throw new Error(
        `Invalid Solana configuration: assets.${assetId}.destinationTokenId`,
      );
    if (isNative && sourceToken.decimals !== 9)
      throw new Error(
        `Invalid Solana configuration: assets.${assetId}.sourceDecimals`,
      );
    const destinationDecimals = Math.min(...decimals);
    try {
      solanaToErgoUnits(networkFee, sourceToken.decimals, destinationDecimals);
      solanaToErgoUnits(bridgeFee, sourceToken.decimals, destinationDecimals);
    } catch {
      throw new Error(`Invalid Solana configuration: assets.${assetId}.fees`);
    }

    resolvedTokenSets.push(tokenSet);
    const programId = isNative
      ? SOLANA_SYSTEM_PROGRAM_ID
      : SOLANA_TOKEN_PROGRAM_ID;
    const resolvedPolicy: SolanaDepositAssetPolicy = {
      program: programId,
      sourceDecimals: sourceToken.decimals,
      destinationDecimals,
      destinationTokenId: destinationToken.tokenId,
      minAmount: policy.minAmount,
      maxAmount: policy.maxAmount,
      networkFee: policy.networkFee,
      bridgeFee: policy.bridgeFee,
      ...(vaultTokenAccount ? { vaultTokenAccount } : {}),
    };
    assets[assetId] = resolvedPolicy;
    descriptorAssets.push({
      assetId: isNative ? SOLANA_NATIVE_TOKEN : assetId,
      programId,
      mint: isNative ? null : assetId,
      vaultTokenAccount,
      sourceDecimals: sourceToken.decimals,
      destinationDecimals,
      destinationTokenId: destinationToken.tokenId,
      minAmount: policy.minAmount,
      maxAmount: policy.maxAmount,
      networkFee: policy.networkFee,
      bridgeFee: policy.bridgeFee,
    });
  }
  if (descriptorAssets.length === 0)
    throw new Error('Invalid Solana configuration: no assets');
  descriptorAssets.sort((a, b) =>
    a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0,
  );
  const resolvedTokenMap = new ResolvedTokenMap(resolvedTokenSets);
  for (const asset of descriptorAssets) {
    for (const tokenId of [asset.assetId, asset.destinationTokenId]) {
      const matchingSets = resolvedTokenSets.filter((tokenSet) =>
        Object.values(tokenSet).some((token) => token.tokenId === tokenId),
      );
      if (matchingSets.length !== 1)
        throw new Error(
          `Invalid Solana configuration: ambiguous token ID ${tokenId}`,
        );
    }
    const significantDecimals = resolvedTokenMap.getSignificantDecimals(
      asset.destinationTokenId,
    );
    const wrapped = resolvedTokenMap.wrapAmount(
      asset.assetId,
      1n,
      SOLANA_CHAIN,
    );
    if (
      significantDecimals !== asset.destinationDecimals ||
      wrapped.decimals !== asset.destinationDecimals
    )
      throw new Error(
        `Invalid Solana configuration: inconsistent token mapping ${asset.assetId}`,
      );
  }

  const frozenAssets = deepFreeze(assets);
  const resolvedProfile = deepFreeze({
    clusterGenesisHash: profile.clusterGenesisHash,
    destinationNetwork: profile.destinationNetwork as 'mainnet' | 'testnet',
    vaultOwner: profile.vaultOwner,
    assets: structuredClone(frozenAssets),
  }) as SolanaRosenExtractorConfig;
  const depositConfig = deepFreeze({
    clusterGenesisHash: profile.clusterGenesisHash,
    destinationNetwork: profile.destinationNetwork as 'mainnet' | 'testnet',
    vaultOwner: profile.vaultOwner,
    assets: frozenAssets,
  });
  const descriptor = deepFreeze({
    genesisHash: profile.clusterGenesisHash,
    destinationChain: ERGO_CHAIN as 'ergo',
    destinationNetwork: profile.destinationNetwork as 'mainnet' | 'testnet',
    vaultOwner: profile.vaultOwner,
    memoVersion: 1 as const,
    projectorVersion: SOLANA_PROJECTOR_VERSION,
    assets: descriptorAssets,
  });
  return {
    profile: resolvedProfile,
    tokens: resolvedTokenMap,
    depositConfig,
    descriptor,
  };
};

const smallIntegerFields = new Set([
  'accountIndex',
  'decimals',
  'index',
  'numReadonlySignedAccounts',
  'numReadonlyUnsignedAccounts',
  'numRequiredSignatures',
  'programIdIndex',
  'slot',
  'version',
]);
const amountFields = new Set(['amount', 'fee']);
const amountArrayFields = new Set(['postBalances', 'preBalances']);
const indexArrayFields = new Set([
  'accounts',
  'readonlyIndexes',
  'writableIndexes',
]);

/**
 * Reject ambiguous duplicate keys without interpreting this parser's numeric
 * output. Its short exponent tokens may already have passed through Number.
 */
const strictRpcJson = JsonBigIntFactory({ strict: true, storeAsString: true });

/**
 * Node >=22.18 exposes each original numeric token in the reviver context.
 * Read integers from that text, never from the possibly rounded Number value.
 * Keep fractional/exponent tokens as text: integer predicates reject them,
 * while unconsumed RPC display fields such as uiAmount remain harmless.
 */
const parseRpcProjection = (serialized: string): unknown => {
  strictRpcJson.parse(serialized);
  return JSON.parse(
    serialized,
    (_field: string, value: unknown, context?: { source?: string }) => {
      if (typeof value !== 'number') return value;
      if (typeof context?.source !== 'string')
        throw new Error('RPC numeric source unavailable');
      return /^(0|[1-9][0-9]*)$/.test(context.source)
        ? BigInt(context.source)
        : context.source;
    },
  );
};

/**
 * Keep money as decimal strings and convert only bounded Solana indices,
 * slots, and decimals to numbers for the validator.
 */
const normalizeRpcProjection = (value: unknown, field = ''): unknown => {
  if (typeof value === 'bigint') {
    if (amountFields.has(field) || amountArrayFields.has(field))
      return value.toString();
    if (smallIntegerFields.has(field) || indexArrayFields.has(field)) {
      if (
        value >= BigInt(Number.MIN_SAFE_INTEGER) &&
        value <= BigInt(Number.MAX_SAFE_INTEGER)
      )
        return Number(value);
    }
    return value;
  }
  if (Array.isArray(value))
    return value.map((entry) => normalizeRpcProjection(entry, field));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        normalizeRpcProjection(entry, key),
      ]),
    );
  }
  return value;
};

export class SolanaRosenExtractor extends AbstractRosenDataExtractor<string> {
  readonly chain = SOLANA_CHAIN;
  private readonly profile: SolanaRosenExtractorConfig;
  private readonly depositConfig: SolanaDepositConfig;
  private readonly resolvedProfile: SolanaResolvedProfile;

  /** Initializes the extractor from the supplied profile and token map. */
  constructor(
    profile: SolanaRosenExtractorConfig,
    tokens: TokenMap,
    logger?: AbstractLogger,
    storeRawData = true,
  ) {
    const resolved = resolveExtractorConfig(profile, tokens);
    super(resolved.profile.vaultOwner, resolved.tokens, logger, storeRawData);
    this.profile = resolved.profile;
    this.depositConfig = resolved.depositConfig;
    this.resolvedProfile = resolved.descriptor;
  }

  /** Returns the frozen profile descriptor resolved from constructor inputs. */
  getResolvedProfile = (): SolanaResolvedProfile => this.resolvedProfile;

  /** Returns the frozen deposit policy used by the local deposit model. */
  private getDepositConfig = (): SolanaDepositConfig => {
    return this.depositConfig;
  };

  /** Projects one supplied transaction input after deposit and token-map checks. */
  private projectInput = (input: Record<string, unknown>): SolanaProjection => {
    const deposit = extractSolanaDeposit(
      input,
      this.getDepositConfig(),
      validateErgoAddress,
    );
    const sourceChainTokenId =
      deposit.sourceAsset === SOLANA_NATIVE_ASSET
        ? SOLANA_NATIVE_TOKEN
        : deposit.sourceAsset;
    const tokenSets = this.tokens.search(SOLANA_CHAIN, {
      tokenId: sourceChainTokenId,
    });
    if (tokenSets.length !== 1) throw new SolanaDepositError('TOKEN_MAP_ENTRY');
    const tokenSet = tokenSets[0];
    const targetChainTokenId = this.tokens.getID(tokenSet, deposit.toChain);
    if (targetChainTokenId !== deposit.destinationTokenId)
      throw new SolanaDepositError('TOKEN_MAP_MISMATCH');

    const transaction = input.transaction as {
      message?: { instructions?: Array<{ data?: unknown }> };
    };
    const memoData = transaction.message?.instructions?.[1]?.data;
    if (typeof memoData !== 'string') throw new SolanaDepositError('MEMO_DATA');
    return {
      deposit,
      data: {
        toChain: deposit.toChain,
        toAddress: deposit.toAddress,
        bridgeFee: deposit.bridgeFee,
        networkFee: deposit.networkFee,
        fromAddress: deposit.fromAddress,
        sourceChainTokenId,
        amount: deposit.sourceAmount,
        targetChainTokenId,
        sourceTxId: deposit.sourceTxId,
        rawData: memoData,
      },
    };
  };

  /** Parses RPC JSON while preserving integer source text, then normalizes fields. */
  private parseInput = (serializedTransaction: string) => {
    const parsed = parseRpcProjection(serializedTransaction);
    return normalizeRpcProjection(parsed) as Record<string, unknown>;
  };

  /** Validates the destination and amount mapping before applying output settings. */
  private finalizeProjection = (
    projection: SolanaProjection,
    preserveRawData = false,
  ): RosenData => {
    try {
      AddressManager.getInstance().validateAddress(
        projection.data.toChain,
        projection.data.toAddress,
      );
    } catch {
      throw new SolanaDepositError('DESTINATION_ADDRESS');
    }
    const wrapped = this.tokens.wrapAmount(
      projection.data.sourceChainTokenId,
      BigInt(projection.data.amount),
      this.chain,
    );
    if (wrapped.amount.toString() !== projection.deposit.amount)
      throw new SolanaDepositError('TOKEN_MAPPING_INVARIANT');
    const data = { ...projection.data, amount: wrapped.amount.toString() };
    if (!this.storeRawData && !preserveRawData)
      data.rawData = 'raw-data extraction is off';
    return data;
  };

  /** Classifies a supplied transaction projection and retains its provided identity. */
  private projectInputWithContext = (
    input: Record<string, unknown>,
  ): SolanaRosenExtractionOutcome => {
    const candidate = hasDepositInstructionPair(input);
    if (candidate === false)
      return { type: 'not-deposit', reason: 'NOT_BRIDGE_INSTRUCTION_PAIR' };
    if (candidate === undefined)
      return { type: 'unavailable', reason: 'INCOMPLETE_TRANSACTION_MESSAGE' };

    if (!hasCompleteTransactionEnvelope(input))
      return { type: 'unavailable', reason: 'INCOMPLETE_RPC_ENVELOPE' };

    const meta = input.meta as Record<string, unknown>;
    if (meta.err !== null)
      return { type: 'not-deposit', reason: 'TRANSACTION_FAILED' };

    try {
      const projection = this.projectInput(input);
      return {
        type: 'deposit',
        data: this.finalizeProjection(projection, true),
        context: {
          clusterGenesisHash: projection.deposit.clusterGenesisHash,
          sourceTxId: projection.deposit.sourceTxId,
          sourceSlot: projection.deposit.sourceSlot,
          sourceBlockhash: projection.deposit.sourceBlockhash,
        },
      };
    } catch (error) {
      const code = errorCode(error);
      return definitelyNotDepositCodes.has(code)
        ? { type: 'not-deposit', reason: code }
        : { type: 'unavailable', reason: code };
    }
  };

  /**
   * Projects one finalized RPC transaction without losing the block identity
   * required by the Solana observation store. The returned RosenData already
   * uses the same final units as the inherited get() path.
   */
  getWithContext = (
    serializedTransaction: string,
  ): SolanaRosenExtractionOutcome => {
    try {
      return this.projectInputWithContext(
        this.parseInput(serializedTransaction),
      );
    } catch (error) {
      return { type: 'unavailable', reason: errorCode(error) };
    }
  };

  /**
   * Projects every transaction from one raw finalized `getBlock` response.
   * Parsing once keeps the RPC's original numeric tokens intact, including
   * wide balances that cannot safely pass through JSON.stringify first.
   */
  getBlockWithContext = (
    serializedBlockResponse: string,
    context: SolanaBlockProjectionContext,
    historyBySignature?: ReadonlyMap<string, unknown>,
  ): SolanaRosenBlockExtractionOutcome => {
    let block: Record<string, unknown>;
    try {
      const parsed = normalizeRpcProjection(
        parseRpcProjection(serializedBlockResponse),
      );
      if (!isRecord(parsed) || !isRecord(parsed.result))
        return { type: 'unavailable', reason: 'INCOMPLETE_RPC_BLOCK' };
      block = parsed.result;
    } catch (error) {
      return { type: 'unavailable', reason: errorCode(error) };
    }
    if (
      !Number.isSafeInteger(context.slot) ||
      context.slot < 0 ||
      typeof context.blockhash !== 'string' ||
      block.blockhash !== context.blockhash ||
      !Array.isArray(block.transactions)
    )
      return { type: 'unavailable', reason: 'BLOCK_CONTEXT_MISMATCH' };

    const transactions: Array<{
      transactionIndex: number;
      signature: string;
      outcome: SolanaRosenExtractionOutcome;
    }> = [];
    for (const [transactionIndex, value] of block.transactions.entries()) {
      if (!isRecord(value))
        return { type: 'unavailable', reason: 'INCOMPLETE_BLOCK_TRANSACTION' };
      const transaction = value.transaction;
      const signatures = isRecord(transaction)
        ? (transaction.signatures as unknown)
        : undefined;
      const signature =
        Array.isArray(signatures) && typeof signatures[0] === 'string'
          ? signatures[0]
          : '';
      if (!signature)
        return { type: 'unavailable', reason: 'INCOMPLETE_BLOCK_SIGNATURE' };
      let meta = value.meta;
      const message = isRecord(transaction) ? transaction.message : undefined;
      const noAddressLookups =
        value.version === 'legacy' ||
        (value.version === 0 &&
          isRecord(message) &&
          Array.isArray(message.addressTableLookups) &&
          message.addressTableLookups.length === 0);
      if (
        isRecord(meta) &&
        !Object.hasOwn(meta, 'loadedAddresses') &&
        noAddressLookups
      )
        meta = { ...meta, loadedAddresses: { writable: [], readonly: [] } };
      const input: Record<string, unknown> = {
        clusterGenesisHash: this.profile.clusterGenesisHash,
        destinationNetwork: this.profile.destinationNetwork,
        commitment: 'finalized',
        slot: context.slot,
        blockhash: context.blockhash,
        version: value.version,
        transaction,
        meta,
      };
      const history = historyBySignature?.get(signature);
      if (history !== undefined) input.history = history;
      transactions.push({
        transactionIndex,
        signature,
        outcome: this.projectInputWithContext(input),
      });
    }
    return { type: 'block', transactions };
  };

  /** Extracts configured deposit data from serialized input or returns undefined. */
  extractData = (serializedTransaction: string): RosenData | undefined => {
    try {
      const input = this.parseInput(serializedTransaction);
      const projection = this.projectInput(input);

      // The exact conversion above must agree with the shared Rosen scale
      // before AbstractRosenDataExtractor performs its generic wrap step.
      const wrapped = this.tokens.wrapAmount(
        projection.data.sourceChainTokenId,
        BigInt(projection.data.amount),
        SOLANA_CHAIN,
      );
      return wrapped.amount.toString() === projection.deposit.amount
        ? projection.data
        : undefined;
    } catch (error) {
      this.logger.debug(
        `No valid Solana Rosen data found: ${errorCode(error)}`,
      );
      return undefined;
    }
  };
}
