import bs58 from 'bs58';

import {
  SOLANA_SYSTEM_PROGRAM_ID,
  SOLANA_TOKEN_PROGRAM_ID,
} from '@rosen-bridge/address-codec-solana';
import { AddressManager } from '@rosen-bridge/address-manager';

import type {
  SolanaDepositConfig,
  SolanaDepositResult,
} from '../../../lib/getRosenData/solana/depositModel';

export type FixtureKind = 'SOL' | 'SPL';

export interface SolanaFixture {
  fixtureKind: FixtureKind;
  input: Record<string, any>;
  config: SolanaDepositConfig;
}

export const addresses = Object.freeze(
  Object.fromEntries(
    [
      'sender',
      'vault',
      'mint',
      'sourceToken',
      'vaultToken',
      'genesis',
      'block',
      'recent',
      'lookup',
      'sponsor',
    ].map((name, index) => [name, bs58.encode(Buffer.alloc(32, index + 1))]),
  ),
) as Record<string, string>;

export const sourceTxId = bs58.encode(Buffer.alloc(64, 21));
export const destination =
  '9fadVRGYyiSBCgD7QtZU13BfGoDyTQ1oX918P8py22MJuMEwSuo';

/** Accept only the fixture destination after validating it as a mainnet Ergo address. */
export const validateErgoAddress = (
  address: string,
  network: string,
): boolean => {
  if (address !== destination || network !== 'mainnet') return false;
  try {
    AddressManager.getInstance().validateAddress('ergo', address);
    return true;
  } catch {
    return false;
  }
};

/** Encode fixture System or SPL transfer instruction bytes and return Base58. */
export const transferBytes = (
  kind: FixtureKind,
  amount: bigint | string,
  decimals = 6,
): string => {
  const data = Buffer.alloc(kind === 'SOL' ? 12 : 10);
  if (kind === 'SOL') {
    data.writeUInt32LE(2);
    data.writeBigUInt64LE(BigInt(amount), 4);
  } else {
    data[0] = 12;
    data.writeBigUInt64LE(BigInt(amount), 1);
    data[9] = decimals;
  }
  return bs58.encode(data);
};

/** Replace the fixture Memo instruction with a serialized deposit payload. */
export const replaceMemo = (
  input: Record<string, any>,
  changes: Record<string, unknown> = {},
): void => {
  const instruction = input.transaction.message.instructions[1];
  const memo = {
    v: 1,
    toChain: 'ergo',
    toAddress: destination,
    asset: input.fixtureKind === 'SOL' ? 'SOL' : addresses.mint,
    amount: '1000000',
    networkFee: '100',
    bridgeFee: '200',
    ...changes,
  };
  instruction.data = bs58.encode(Buffer.from(JSON.stringify(memo)));
};

/** Build a deterministic SOL or SPL transaction, config, and history fixture. */
export const makeFixture = (kind: FixtureKind = 'SOL'): SolanaFixture => {
  const token = kind === 'SPL';
  const a = addresses;
  const keys = token
    ? [
        a.sender,
        a.sourceToken,
        a.vaultToken,
        a.mint,
        SOLANA_TOKEN_PROGRAM_ID,
        'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
      ]
    : [
        a.sender,
        a.vault,
        SOLANA_SYSTEM_PROGRAM_ID,
        'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
      ];
  const assetPolicy = {
    program: {
      SOL: SOLANA_SYSTEM_PROGRAM_ID,
      SPL: SOLANA_TOKEN_PROGRAM_ID,
    }[kind],
    sourceDecimals: token ? 6 : 9,
    destinationDecimals: token ? 6 : 9,
    destinationTokenId: (token ? 'ab' : 'cd').repeat(32),
    minAmount: '1',
    maxAmount: '18446744073709551615',
    networkFee: '100',
    bridgeFee: '200',
    ...(token ? { vaultTokenAccount: a.vaultToken } : {}),
  };
  const config: SolanaDepositConfig = {
    clusterGenesisHash: a.genesis,
    destinationNetwork: 'mainnet',
    vaultOwner: a.vault,
    assets: { [token ? a.mint : 'SOL']: assetPolicy },
  };
  const input: Record<string, any> = {
    fixtureKind: kind,
    clusterGenesisHash: a.genesis,
    destinationNetwork: 'mainnet',
    commitment: 'finalized',
    slot: 100,
    blockhash: a.block,
    version: 'legacy',
    transaction: {
      signatures: [sourceTxId],
      message: {
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: token ? 3 : 2,
        },
        accountKeys: keys,
        recentBlockhash: a.recent,
        instructions: [
          {
            programIdIndex: token ? 4 : 2,
            accounts: token ? [1, 3, 2, 0] : [0, 1],
            data: transferBytes(kind, '1000000'),
          },
          {
            programIdIndex: token ? 5 : 3,
            accounts: [0],
            data: '',
          },
        ],
      },
    },
    meta: {
      err: null,
      fee: '5000',
      innerInstructions: [],
      loadedAddresses: { writable: [], readonly: [] },
      preBalances: token
        ? ['2000000', '2039280', '2039280', '1461600', '1', '1']
        : ['2005000', '1000000', '1', '1'],
      postBalances: token
        ? ['1995000', '2039280', '2039280', '1461600', '1', '1']
        : ['1000000', '2000000', '1', '1'],
      preTokenBalances: [],
      postTokenBalances: [],
    },
  };

  if (token) {
    /** Create an initialized token-account state for one history snapshot. */
    const state = (address: string, owner: string, amount: string) => ({
      address,
      programOwner: SOLANA_TOKEN_PROGRAM_ID,
      mint: a.mint,
      owner,
      amount,
      state: 'initialized',
      extensions: [],
      delegate: null,
      closeAuthority: null,
    });
    const mintState = {
      programOwner: SOLANA_TOKEN_PROGRAM_ID,
      decimals: 6,
      extensions: [],
    };
    input.history = {
      slot: input.slot,
      sourceTxId,
      clusterGenesisHash: a.genesis,
      mint: {
        address: a.mint,
        pre: structuredClone(mintState),
        post: structuredClone(mintState),
      },
      source: {
        pre: state(a.sourceToken, a.sender, '2000000'),
        post: state(a.sourceToken, a.sender, '1000000'),
      },
      vault: {
        pre: state(a.vaultToken, a.vault, '0'),
        post: state(a.vaultToken, a.vault, '1000000'),
      },
    };
    /** Create RPC token-balance metadata matching one token-account state. */
    const balance = (accountIndex: number, account: Record<string, any>) => ({
      accountIndex,
      mint: account.mint,
      owner: account.owner,
      programId: SOLANA_TOKEN_PROGRAM_ID,
      uiTokenAmount: { amount: account.amount, decimals: 6 },
    });
    input.meta.preTokenBalances = [
      balance(1, input.history.source.pre),
      balance(2, input.history.vault.pre),
    ];
    input.meta.postTokenBalances = [
      balance(1, input.history.source.post),
      balance(2, input.history.vault.post),
    ];
  }

  replaceMemo(input);
  return { fixtureKind: kind, input, config };
};

/** Move the fixture vault key into loaded writable addresses and update indices. */
export const withLookup = (fixture: SolanaFixture): SolanaFixture => {
  const result = structuredClone(fixture);
  const message = result.input.transaction.message;
  const vaultIndex = result.fixtureKind === 'SOL' ? 1 : 2;
  const [vault] = message.accountKeys.splice(vaultIndex, 1);
  for (const instruction of message.instructions) {
    if (instruction.programIdIndex > vaultIndex) instruction.programIdIndex--;
    instruction.accounts = instruction.accounts.map((index: number) =>
      index === vaultIndex
        ? message.accountKeys.length
        : index > vaultIndex
          ? index - 1
          : index,
    );
  }
  for (const field of ['preBalances', 'postBalances']) {
    const [balance] = result.input.meta[field].splice(vaultIndex, 1);
    result.input.meta[field].push(balance);
  }
  for (const field of ['preTokenBalances', 'postTokenBalances']) {
    for (const balance of result.input.meta[field]) {
      balance.accountIndex =
        balance.accountIndex === vaultIndex
          ? message.accountKeys.length
          : balance.accountIndex > vaultIndex
            ? balance.accountIndex - 1
            : balance.accountIndex;
    }
  }
  result.input.version = 0;
  result.input.meta.loadedAddresses.writable = [vault];
  message.addressTableLookups = [
    {
      accountKey: addresses.lookup,
      writableIndexes: [7],
      readonlyIndexes: [],
    },
  ];
  return result;
};

/** Return the expected Rosen deposit fields for the selected source asset. */
export const expectedDeposit = (
  kind: FixtureKind,
): Pick<
  SolanaDepositResult,
  | 'sourceChain'
  | 'sourceTxId'
  | 'sourceAsset'
  | 'sourceAmount'
  | 'fromAddress'
  | 'toChain'
  | 'toAddress'
  | 'amount'
  | 'networkFee'
  | 'bridgeFee'
  | 'recipientAmount'
  | 'tokenProgram'
> => ({
  sourceChain: 'solana',
  sourceTxId,
  sourceAsset: kind === 'SOL' ? 'SOL' : addresses.mint,
  sourceAmount: '1000000',
  fromAddress: addresses.sender,
  toChain: 'ergo',
  toAddress: destination,
  amount: '1000000',
  networkFee: '100',
  bridgeFee: '200',
  recipientAmount: '999700',
  tokenProgram:
    kind === 'SOL' ? SOLANA_SYSTEM_PROGRAM_ID : SOLANA_TOKEN_PROGRAM_ID,
});
