import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';

import { SOLANA_TOKEN_2022_PROGRAM_ID } from '@rosen-bridge/address-codec-solana';

import {
  SolanaDepositError,
  extractSolanaDeposit,
} from '../../../lib/getRosenData/solana/depositModel';
import {
  addresses,
  destination,
  makeFixture,
  replaceMemo,
  sourceTxId,
  transferBytes,
  validateErgoAddress,
  withLookup,
} from './testData';

type Kind = 'SOL' | 'SPL';
type Fixture = ReturnType<typeof makeFixture>;
type Mutation = (fixture: Fixture) => void;

interface NegativeCase {
  name: string;
  kind: Kind;
  code: string;
  mutate: Mutation;
}

const rejects = (fixture: Fixture, code: string): void => {
  let error: unknown;
  try {
    extractSolanaDeposit(fixture.input, fixture.config, validateErgoAddress);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(SolanaDepositError);
  expect((error as SolanaDepositError).code).toBe(code);
};

const setMemo = (fixture: Fixture, memo: string): void => {
  fixture.input.transaction.message.instructions[1].data = memo;
};

const negatives: NegativeCase[] = [
  {
    name: 'wrong cluster cannot authorize a deposit',
    kind: 'SOL',
    code: 'CLUSTER',
    mutate: (f) => {
      f.input.clusterGenesisHash = addresses.block;
    },
  },
  {
    name: 'wrong destination network is refused',
    kind: 'SOL',
    code: 'DESTINATION_NETWORK',
    mutate: (f) => {
      f.input.destinationNetwork = 'testnet';
    },
  },
  {
    name: 'confirmed is insufficient',
    kind: 'SOL',
    code: 'FINALITY',
    mutate: (f) => {
      f.input.commitment = 'confirmed';
    },
  },
  {
    name: 'failed transfer is refused despite positive balances',
    kind: 'SOL',
    code: 'TRANSACTION_FAILED',
    mutate: (f) => {
      f.input.meta.err = { InstructionError: [0, 'Custom'] };
    },
  },
  {
    name: 'missing execution metadata fails closed',
    kind: 'SOL',
    code: 'TRANSACTION_FAILED',
    mutate: (f) => {
      delete f.input.meta;
    },
  },
  {
    name: 'missing inner trace is not an empty trace',
    kind: 'SOL',
    code: 'CPI_OR_MISSING_TRACE',
    mutate: (f) => {
      f.input.meta.innerInstructions = null;
    },
  },
  {
    name: 'any CPI is outside the outer-only profile',
    kind: 'SOL',
    code: 'CPI_OR_MISSING_TRACE',
    mutate: (f) => {
      f.input.meta.innerInstructions = [
        {
          index: 0,
          instructions: [
            {
              programIdIndex: 2,
              accounts: [0, 1],
              data: transferBytes('SOL', '1'),
            },
          ],
        },
      ];
    },
  },
  {
    name: 'v1 requires a separately reviewed decoder',
    kind: 'SOL',
    code: 'TX_VERSION',
    mutate: (f) => {
      f.input.version = 1;
    },
  },
  {
    name: 'unknown transaction version is refused',
    kind: 'SPL',
    code: 'TX_VERSION',
    mutate: (f) => {
      f.input.version = 7;
    },
  },
  {
    name: 'missing loaded addresses is not inferred',
    kind: 'SOL',
    code: 'LOADED_ADDRESSES',
    mutate: (f) => {
      delete f.input.meta.loadedAddresses;
    },
  },
  {
    name: 'ALT omitted address cannot redirect the vault',
    kind: 'SOL',
    code: 'LOOKUP_METADATA',
    mutate: (f) => {
      const lookup = withLookup(f);
      f.input.version = lookup.input.version;
      f.input.meta.loadedAddresses = lookup.input.meta.loadedAddresses;
    },
  },
  {
    name: 'invalid instruction account index is bounded',
    kind: 'SOL',
    code: 'ACCOUNT_INDEX',
    mutate: (f) => {
      f.input.transaction.message.instructions[0].accounts[1] = 999;
    },
  },
  {
    name: 'signature encoding must be canonical and 64 bytes',
    kind: 'SOL',
    code: 'BASE58_ENCODING',
    mutate: (f) => {
      f.input.transaction.signatures[0] = '0';
    },
  },
  {
    name: 'duplicate message keys are rejected',
    kind: 'SOL',
    code: 'ACCOUNT_KEYS',
    mutate: (f) => {
      f.input.transaction.message.accountKeys[1] = addresses.sender;
    },
  },
  {
    name: 'memo alone is not a payment',
    kind: 'SOL',
    code: 'INSTRUCTION_COUNT',
    mutate: (f) => {
      f.input.transaction.message.instructions.shift();
    },
  },
  {
    name: 'a second memo makes intent ambiguous',
    kind: 'SOL',
    code: 'INSTRUCTION_COUNT',
    mutate: (f) => {
      f.input.transaction.message.instructions.push(
        structuredClone(f.input.transaction.message.instructions[1]),
      );
    },
  },
  {
    name: 'a second payment cannot hide behind one intent',
    kind: 'SOL',
    code: 'INSTRUCTION_COUNT',
    mutate: (f) => {
      f.input.transaction.message.instructions.unshift(
        structuredClone(f.input.transaction.message.instructions[0]),
      );
    },
  },
  {
    name: 'invalid UTF-8 Memo is refused',
    kind: 'SOL',
    code: 'MEMO_ENCODING',
    mutate: (f) => {
      setMemo(f, bs58.encode(Buffer.from([0xff])));
    },
  },
  {
    name: 'unsigned Memo authority is refused',
    kind: 'SPL',
    code: 'MEMO_AUTHORITY',
    mutate: (f) => {
      f.input.transaction.message.instructions[1].accounts = [1];
    },
  },
  {
    name: 'unvalidated Ergo destination is refused',
    kind: 'SOL',
    code: 'DESTINATION',
    mutate: (f) => {
      replaceMemo(f.input, { toAddress: 'not-an-ergo-address' });
    },
  },
  {
    name: 'Memo amount cannot override the payment',
    kind: 'SOL',
    code: 'MEMO_PAYMENT',
    mutate: (f) => {
      replaceMemo(f.input, { amount: '999999' });
    },
  },
  {
    name: 'Memo fees cannot override trusted policy',
    kind: 'SOL',
    code: 'FEE_POLICY',
    mutate: (f) => {
      replaceMemo(f.input, { bridgeFee: '1' });
    },
  },
  {
    name: 'fees cannot consume the full deposit',
    kind: 'SOL',
    code: 'FEE_EXHAUSTS_AMOUNT',
    mutate: (f) => {
      f.config.assets.SOL.bridgeFee = '999900';
      replaceMemo(f.input, { bridgeFee: '999900' });
    },
  },
  {
    name: 'successful self-transfer is not a deposit',
    kind: 'SOL',
    code: 'SELF_TRANSFER',
    mutate: (f) => {
      f.input.transaction.message.instructions[0].accounts[1] = 0;
    },
  },
  {
    name: 'zero transfer yields no event',
    kind: 'SPL',
    code: 'ZERO_AMOUNT',
    mutate: (f) => {
      f.input.transaction.message.instructions[0].data = transferBytes(
        'SPL',
        '0',
      );
    },
  },
  {
    name: 'readonly payment destination is refused',
    kind: 'SOL',
    code: 'PAYMENT_WRITABLE',
    mutate: (f) => {
      f.input.transaction.message.header.numReadonlyUnsignedAccounts = 3;
    },
  },
  {
    name: 'non-signing token owner cannot authorize payment',
    kind: 'SPL',
    code: 'PAYMENT_SIGNER',
    mutate: (f) => {
      f.input.transaction.message.instructions[0].accounts[3] = 3;
    },
  },
  {
    name: 'unknown program with transfer-shaped data is refused',
    kind: 'SOL',
    code: 'PROGRAM_DENIED',
    mutate: (f) => {
      f.input.transaction.message.accountKeys[2] = addresses.lookup;
    },
  },
  {
    name: 'Token-2022 does not inherit original Token support',
    kind: 'SPL',
    code: 'TOKEN_2022_DENIED',
    mutate: (f) => {
      f.input.transaction.message.accountKeys[4] = SOLANA_TOKEN_2022_PROGRAM_ID;
    },
  },
  {
    name: 'unchecked SPL transfer is outside the initial profile',
    kind: 'SPL',
    code: 'TOKEN_TRANSFER_CHECKED',
    mutate: (f) => {
      f.input.transaction.message.instructions[0].data = bs58.encode(
        Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0, 0]),
      );
    },
  },
  {
    name: 'wSOL is not silently normalized to SOL',
    kind: 'SPL',
    code: 'WSOL_DENIED',
    mutate: (f) => {
      f.input.transaction.message.accountKeys[3] =
        'So11111111111111111111111111111111111111112';
    },
  },
  {
    name: 'unlisted mint is refused',
    kind: 'SPL',
    code: 'UNSUPPORTED_ASSET',
    mutate: (f) => {
      f.input.transaction.message.accountKeys[3] = addresses.lookup;
    },
  },
  {
    name: 'TransferChecked decimals must match admitted asset',
    kind: 'SPL',
    code: 'ASSET_POLICY',
    mutate: (f) => {
      f.input.transaction.message.instructions[0].data = transferBytes(
        'SPL',
        '1000000',
        9,
      );
    },
  },
  {
    name: 'wrong custody destination is refused',
    kind: 'SOL',
    code: 'VAULT_DESTINATION',
    mutate: (f) => {
      f.input.transaction.message.accountKeys[1] = addresses.sponsor;
    },
  },
  {
    name: 'configured minimum amount is enforced',
    kind: 'SOL',
    code: 'AMOUNT_POLICY',
    mutate: (f) => {
      f.config.assets.SOL.minAmount = '1000001';
    },
  },
  {
    name: 'destination token mapping must be a canonical token ID',
    kind: 'SOL',
    code: 'DESTINATION_TOKEN_ID',
    mutate: (f) => {
      f.config.assets.SOL.destinationTokenId = 'placeholder';
    },
  },
  {
    name: 'destination decimals stay within the selected profile',
    kind: 'SOL',
    code: 'DECIMALS',
    mutate: (f) => {
      f.config.assets.SOL.destinationDecimals = 19;
    },
  },
  {
    name: 'RPC money supplied as a JavaScript number is refused',
    kind: 'SOL',
    code: 'INTEGER_ENCODING',
    mutate: (f) => {
      f.input.meta.preBalances[0] = 2005000;
    },
  },
  {
    name: 'leading zero amount is refused',
    kind: 'SOL',
    code: 'INTEGER_ENCODING',
    mutate: (f) => {
      replaceMemo(f.input, { amount: '01000000' });
    },
  },
  {
    name: 'u64 overflow in metadata is refused',
    kind: 'SOL',
    code: 'INTEGER_RANGE',
    mutate: (f) => {
      f.input.meta.preBalances[0] = '18446744073709551616';
    },
  },
  {
    name: 'deposit credit must match the vault balance delta',
    kind: 'SOL',
    code: 'SOL_DELTA',
    mutate: (f) => {
      f.input.meta.postBalances[1] = '1000000';
    },
  },
  {
    name: 'payer debit accounts for the network fee separately',
    kind: 'SOL',
    code: 'SOL_DELTA',
    mutate: (f) => {
      f.input.meta.postBalances[0] = '1005000';
    },
  },
  {
    name: 'SPL history binds the exact transaction signature',
    kind: 'SPL',
    code: 'HISTORY_BINDING',
    mutate: (f) => {
      f.input.history.sourceTxId = bs58.encode(Buffer.alloc(64, 22));
    },
  },
  {
    name: 'current state cannot replace deposit-slot history',
    kind: 'SPL',
    code: 'HISTORY_BINDING',
    mutate: (f) => {
      f.input.history.slot = 101;
    },
  },
  {
    name: 'mint program is established by historical evidence',
    kind: 'SPL',
    code: 'MINT_HISTORY',
    mutate: (f) => {
      f.input.history.mint.post.programOwner = SOLANA_TOKEN_2022_PROGRAM_ID;
    },
  },
  {
    name: 'mint extensions cannot appear unnoticed',
    kind: 'SPL',
    code: 'MINT_HISTORY',
    mutate: (f) => {
      f.input.history.mint.post.extensions = ['TransferFeeConfig'];
    },
  },
  {
    name: 'closed token account is not inferred to have zero balance',
    kind: 'SPL',
    code: 'TOKEN_STATE',
    mutate: (f) => {
      f.input.history.source.post = null;
    },
  },
  {
    name: 'recreated token account with another mint is refused',
    kind: 'SPL',
    code: 'TOKEN_STATE',
    mutate: (f) => {
      f.input.history.source.post.mint = addresses.lookup;
    },
  },
  {
    name: 'source authority change in the transaction is refused',
    kind: 'SPL',
    code: 'TOKEN_STATE',
    mutate: (f) => {
      f.input.history.source.post.owner = addresses.sponsor;
    },
  },
  {
    name: 'frozen vault is refused',
    kind: 'SPL',
    code: 'TOKEN_STATE',
    mutate: (f) => {
      f.input.history.vault.pre.state = 'frozen';
    },
  },
  {
    name: 'vault delegate is not allowed to drain custody',
    kind: 'SPL',
    code: 'VAULT_AUTHORITY',
    mutate: (f) => {
      f.input.history.vault.pre.delegate = addresses.sponsor;
    },
  },
  {
    name: 'vault close authority remains pinned to policy',
    kind: 'SPL',
    code: 'VAULT_AUTHORITY',
    mutate: (f) => {
      f.input.history.vault.post.closeAuthority = addresses.sponsor;
    },
  },
  {
    name: 'SPL execution delta must match the claimed transfer',
    kind: 'SPL',
    code: 'TOKEN_DELTA',
    mutate: (f) => {
      f.input.history.vault.post.amount = '999999';
    },
  },
  {
    name: 'RPC balance amount must match historical account state',
    kind: 'SPL',
    code: 'TOKEN_METADATA',
    mutate: (f) => {
      f.input.meta.postTokenBalances[1].uiTokenAmount.amount = '999999';
    },
  },
  {
    name: 'RPC missing owner is not inferred from current state',
    kind: 'SPL',
    code: 'TOKEN_METADATA',
    mutate: (f) => {
      delete f.input.meta.postTokenBalances[1].owner;
    },
  },
  {
    name: 'duplicate RPC token-balance entries are ambiguous',
    kind: 'SPL',
    code: 'TOKEN_METADATA',
    mutate: (f) => {
      f.input.meta.postTokenBalances.push(
        structuredClone(f.input.meta.postTokenBalances[1]),
      );
    },
  },
  {
    name: 'network fee mapping refuses fractional destination base units',
    kind: 'SPL',
    code: 'MAPPING_DUST',
    mutate: (f) => {
      f.config.assets[addresses.mint].destinationDecimals = 2;
    },
  },
];

const additionalNegatives: NegativeCase[] = [];
const negative = (
  name: string,
  kind: Kind,
  code: string,
  mutate: Mutation,
): void => {
  additionalNegatives.push({ name, kind, code, mutate });
};
const changeTransferData = (
  fixture: Fixture,
  change: (data: Buffer) => Buffer,
): void => {
  const instruction = fixture.input.transaction.message.instructions[0];
  instruction.data = bs58.encode(
    change(Buffer.from(bs58.decode(instruction.data))),
  );
};
const changeMemoText = (
  fixture: Fixture,
  change: (text: string) => string,
): void => {
  const instruction = fixture.input.transaction.message.instructions[1];
  instruction.data = bs58.encode(
    Buffer.from(
      change(Buffer.from(bs58.decode(instruction.data)).toString('utf8')),
    ),
  );
};

const uniqueKeys = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => {
    const bytes = Buffer.alloc(32, 42);
    bytes.writeUInt32LE(index);
    return bs58.encode(bytes);
  });

negative(
  'static message keys are bounded before resolution',
  'SOL',
  'ACCOUNT_KEYS',
  (f) => {
    f.input.transaction.message.accountKeys = uniqueKeys(257);
  },
);
negative(
  'combined static and loaded message keys are bounded',
  'SOL',
  'ACCOUNT_KEYS',
  (f) => {
    f.input = withLookup(f).input;
    const loaded = uniqueKeys(254);
    f.input.meta.loadedAddresses.writable = loaded;
    f.input.transaction.message.addressTableLookups[0].writableIndexes =
      loaded.map((_, index) => index);
  },
);

negative(
  'SPL debit remains mandatory when source history and RPC copies agree',
  'SPL',
  'TOKEN_DELTA',
  (f) => {
    f.input.history.source.post.amount = '2000000';
    f.input.meta.postTokenBalances[0].uiTokenAmount.amount = '2000000';
  },
);
negative(
  'SPL credit remains mandatory when vault history and RPC copies agree',
  'SPL',
  'TOKEN_DELTA',
  (f) => {
    f.input.history.vault.post.amount = '0';
    f.input.meta.postTokenBalances[1].uiTokenAmount.amount = '0';
  },
);
negative(
  'history cluster must match configured cluster',
  'SPL',
  'HISTORY_BINDING',
  (f) => {
    f.input.history.clusterGenesisHash = addresses.block;
  },
);
negative(
  'post-state vault delegate is forbidden',
  'SPL',
  'VAULT_AUTHORITY',
  (f) => {
    f.input.history.vault.post.delegate = addresses.sponsor;
  },
);
negative(
  'pre-state vault close authority is forbidden',
  'SPL',
  'VAULT_AUTHORITY',
  (f) => {
    f.input.history.vault.pre.closeAuthority = addresses.sponsor;
  },
);
negative(
  'network fee independently matches policy',
  'SOL',
  'FEE_POLICY',
  (f) => {
    replaceMemo(f.input, { networkFee: '101' });
  },
);
negative(
  'configured maximum amount is enforced',
  'SOL',
  'AMOUNT_POLICY',
  (f) => {
    f.config.assets.SOL.maxAmount = '999999';
  },
);
negative('configured token program is enforced', 'SPL', 'ASSET_POLICY', (f) => {
  f.config.assets[addresses.mint].program = SOLANA_TOKEN_2022_PROGRAM_ID;
});
negative(
  'vault owner cannot be the SPL depositor',
  'SPL',
  'VAULT_AS_SENDER',
  (f) => {
    f.config.vaultOwner = addresses.sender;
  },
);
negative(
  'SPL custody destination is enforced',
  'SPL',
  'VAULT_DESTINATION',
  (f) => {
    f.config.assets[addresses.mint].vaultTokenAccount = addresses.sponsor;
  },
);
negative(
  'bridge fee mapping independently rejects dust',
  'SPL',
  'MAPPING_DUST',
  (f) => {
    Object.assign(f.config.assets[addresses.mint], {
      destinationDecimals: 3,
      networkFee: '1000',
      bridgeFee: '2001',
    });
    replaceMemo(f.input, { networkFee: '1000', bridgeFee: '2001' });
  },
);
negative(
  'payment mapping independently rejects dust',
  'SPL',
  'MAPPING_DUST',
  (f) => {
    Object.assign(f.config.assets[addresses.mint], {
      destinationDecimals: 3,
      networkFee: '1000',
      bridgeFee: '2000',
    });
    f.input.transaction.message.instructions[0].data = transferBytes(
      'SPL',
      '1000001',
    );
    replaceMemo(f.input, {
      amount: '1000001',
      networkFee: '1000',
      bridgeFee: '2000',
    });
    f.input.history.source.post.amount = '999999';
    f.input.history.vault.post.amount = '1000001';
    f.input.meta.postTokenBalances[0].uiTokenAmount.amount = '999999';
    f.input.meta.postTokenBalances[1].uiTokenAmount.amount = '1000001';
  },
);

for (const kind of ['SOL', 'SPL'] as const) {
  const code = kind === 'SOL' ? 'SYSTEM_TRANSFER' : 'TOKEN_TRANSFER_CHECKED';
  negative(
    `${kind}: payment account arity is independently enforced`,
    kind,
    code,
    (f) => {
      f.input.transaction.message.instructions[0].accounts.pop();
    },
  );
  negative(
    `${kind}: payment byte length is independently enforced`,
    kind,
    code,
    (f) => {
      changeTransferData(f, (data) => Buffer.concat([data, Buffer.from([0])]));
    },
  );
}
negative(
  'System Transfer opcode is independently enforced',
  'SOL',
  'SYSTEM_TRANSFER',
  (f) => {
    changeTransferData(f, (data) => {
      data.writeUInt32LE(3);
      return data;
    });
  },
);
negative('second native mint is excluded', 'SPL', 'WSOL_DENIED', (f) => {
  f.input.transaction.message.accountKeys[3] =
    '9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP';
});
negative('Memo program identity is mandatory', 'SOL', 'MEMO_AUTHORITY', (f) => {
  f.input.transaction.message.instructions[1].programIdIndex = 2;
});
for (const accounts of [[], [0, 1]]) {
  negative(
    `Memo requires one authority account: ${accounts.length}`,
    'SOL',
    'MEMO_AUTHORITY',
    (f) => {
      f.input.transaction.message.instructions[1].accounts = accounts;
    },
  );
}
for (const [name, change] of [
  ['additional property', (text: string) => text.replace('}', ',"extra":0}')],
  [
    'reordered properties',
    (text: string) =>
      text.replace('"v":1,"toChain":"ergo"', '"toChain":"ergo","v":1'),
  ],
  ['noncompact bytes', (text: string) => ` ${text}`],
  ['nonobject JSON', () => 'null'],
] as const) {
  negative(`canonical Memo rejects ${name}`, 'SOL', 'MEMO_CANONICAL', (f) =>
    changeMemoText(f, change),
  );
}
for (const change of [{ v: 2 }, { toChain: 'cardano' }]) {
  negative(
    `Memo rejects ${JSON.stringify(change)}`,
    'SOL',
    'MEMO_VERSION_CHAIN',
    (f) => replaceMemo(f.input, change),
  );
}
negative(
  'Memo asset is independently bound to transfer',
  'SOL',
  'MEMO_PAYMENT',
  (f) => {
    replaceMemo(f.input, { asset: addresses.mint });
  },
);
negative(
  'signed SOL source must also be writable',
  'SOL',
  'PAYMENT_WRITABLE',
  (f) => {
    f.input.transaction.message.header.numReadonlySignedAccounts = 1;
  },
);
negative(
  'v0 loaded readonly destination is refused',
  'SOL',
  'PAYMENT_WRITABLE',
  (f) => {
    f.input = withLookup(f).input;
    f.input.meta.loadedAddresses.readonly =
      f.input.meta.loadedAddresses.writable;
    f.input.meta.loadedAddresses.writable = [];
    const lookup = f.input.transaction.message.addressTableLookups[0];
    lookup.readonlyIndexes = lookup.writableIndexes;
    lookup.writableIndexes = [];
  },
);
negative(
  'v0 loaded address cannot sign for token owner',
  'SPL',
  'PAYMENT_SIGNER',
  (f) => {
    f.input = withLookup(f).input;
    f.input.transaction.message.instructions[0].accounts[3] =
      f.input.transaction.message.accountKeys.length;
  },
);
for (const field of ['preBalances', 'postBalances']) {
  negative(
    `${field} must cover every resolved account`,
    'SOL',
    'SOL_METADATA',
    (f) => {
      f.input.meta[field].pop();
    },
  );
}
negative(
  'sponsored SOL debit excludes sponsor fee',
  'SOL',
  'SOL_DELTA',
  (f) => {
    const message = f.input.transaction.message;
    message.accountKeys.unshift(addresses.sponsor);
    message.header.numRequiredSignatures = 2;
    f.input.transaction.signatures.unshift(sourceTxId);
    for (const instruction of message.instructions) {
      instruction.programIdIndex++;
      instruction.accounts = instruction.accounts.map(
        (index: number) => index + 1,
      );
    }
    f.input.meta.preBalances.unshift('10000');
    f.input.meta.postBalances.unshift('5000');
    // Original source debit still includes 5000, now paid by the sponsor.
  },
);

// Field predicates share helpers; role/phase probes below independently cover
// each call site without multiplying every field by every role and phase.
for (const [field, value] of [
  ['programOwner', SOLANA_TOKEN_2022_PROGRAM_ID],
  ['decimals', 9],
  ['extensions', null],
  ['extensions', ['TransferFeeConfig']],
] as const) {
  negative(
    `historical mint pre ${field} rejects ${JSON.stringify(value)}`,
    'SPL',
    'MINT_HISTORY',
    (f) => {
      f.input.history.mint.pre[field] = value;
    },
  );
}
negative(
  'historical mint address matches payment asset',
  'SPL',
  'MINT_HISTORY',
  (f) => {
    f.input.history.mint.address = addresses.sponsor;
  },
);
for (const [field, value] of [
  ['address', addresses.sponsor],
  ['programOwner', SOLANA_TOKEN_2022_PROGRAM_ID],
  ['mint', addresses.sponsor],
  ['owner', addresses.sponsor],
  ['state', 'frozen'],
  ['extensions', null],
  ['extensions', ['TransferFeeAmount']],
] as const) {
  negative(
    `historical source pre ${field} rejects ${JSON.stringify(value)}`,
    'SPL',
    'TOKEN_STATE',
    (f) => {
      f.input.history.source.pre[field] = value;
      if (field === 'mint' || field === 'owner')
        f.input.meta.preTokenBalances[0][field] = value;
    },
  );
}
for (const role of ['source', 'vault'] as const) {
  for (const phase of ['pre', 'post'] as const) {
    negative(
      `${role} ${phase} historical account identity is checked`,
      'SPL',
      'TOKEN_STATE',
      (f) => {
        f.input.history[role][phase].address = addresses.sponsor;
      },
    );
    const field = phase === 'pre' ? 'preTokenBalances' : 'postTokenBalances';
    const index = role === 'source' ? 0 : 1;
    negative(
      `${role} ${phase} RPC amount is independently checked`,
      'SPL',
      'TOKEN_METADATA',
      (f) => {
        f.input.meta[field][index].uiTokenAmount.amount = '7';
      },
    );
    negative(
      `${role} ${phase} RPC balance is required`,
      'SPL',
      'TOKEN_METADATA',
      (f) => {
        f.input.meta[field].splice(index, 1);
      },
    );
  }
}
for (const [field, value] of [
  ['programId', SOLANA_TOKEN_2022_PROGRAM_ID],
  ['mint', addresses.sponsor],
  ['owner', addresses.sponsor],
] as const) {
  negative(
    `RPC source pre ${field} must match history`,
    'SPL',
    'TOKEN_METADATA',
    (f) => {
      f.input.meta.preTokenBalances[0][field] = value;
    },
  );
}
negative(
  'RPC source pre decimals must match policy',
  'SPL',
  'TOKEN_METADATA',
  (f) => {
    f.input.meta.preTokenBalances[0].uiTokenAmount.decimals = 9;
  },
);

for (const [field, value] of [
  ['numRequiredSignatures', 0],
  ['numRequiredSignatures', 5],
  ['numReadonlySignedAccounts', 2],
  ['numReadonlyUnsignedAccounts', 4],
] as const) {
  negative(`header ${field} rejects ${value}`, 'SOL', 'HEADER', (f) => {
    f.input.transaction.message.header[field] = value;
  });
}
for (const value of ['100', 0.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
  negative(`slot rejects ${JSON.stringify(value)}`, 'SOL', 'SLOT', (f) => {
    f.input.slot = value;
  });
}
for (const count of [0, 2]) {
  negative(
    `signature count ${count} disagrees with header`,
    'SOL',
    'SIGNATURES',
    (f) => {
      f.input.transaction.signatures = Array(count).fill(sourceTxId);
    },
  );
}
for (const signature of [
  '',
  bs58.encode(Buffer.alloc(63, 1)),
  bs58.encode(Buffer.alloc(65, 1)),
]) {
  negative(
    `signature size or emptiness is bounded: ${signature.length}`,
    'SOL',
    'BASE58_ENCODING',
    (f) => {
      f.input.transaction.signatures[0] = signature;
    },
  );
}
negative('block key must decode to 32 bytes', 'SOL', 'BASE58_ENCODING', (f) => {
  f.input.blockhash = bs58.encode(Buffer.alloc(31, 1));
});
negative(
  'instruction byte allocation is bounded',
  'SOL',
  'BASE58_ENCODING',
  (f) => {
    f.input.transaction.message.instructions[1].data = bs58.encode(
      Buffer.alloc(769, 1),
    );
  },
);
for (const field of ['writable', 'readonly']) {
  negative(
    `legacy rejects loaded ${field} addresses`,
    'SOL',
    'LEGACY_LOOKUPS',
    (f) => {
      f.input.meta.loadedAddresses[field] = [addresses.sponsor];
    },
  );
}
negative(
  'legacy rejects nonempty lookup descriptors',
  'SOL',
  'LEGACY_LOOKUPS',
  (f) => {
    f.input.transaction.message.addressTableLookups = [{}];
  },
);
for (const field of ['writableIndexes', 'readonlyIndexes']) {
  negative(`v0 ${field} are u8 indices`, 'SOL', 'LOOKUP_METADATA', (f) => {
    f.input = withLookup(f).input;
    f.input.transaction.message.addressTableLookups[0][field] = [256];
  });
}
for (const field of ['writable', 'readonly']) {
  negative(
    `v0 loaded ${field} count matches lookup descriptors`,
    'SOL',
    'LOOKUP_METADATA',
    (f) => {
      f.input = withLookup(f).input;
      f.input.meta.loadedAddresses[field].push(addresses.sponsor);
    },
  );
}
negative(
  'v0 loaded keys cannot duplicate static keys',
  'SOL',
  'ACCOUNT_KEYS',
  (f) => {
    f.input = withLookup(f).input;
    f.input.meta.loadedAddresses.writable[0] = addresses.sender;
  },
);
negative(
  'program index is independently bounded',
  'SOL',
  'ACCOUNT_INDEX',
  (f) => {
    f.input.transaction.message.instructions[0].programIdIndex = 999;
  },
);
negative(
  'instruction account vector length is bounded',
  'SOL',
  'INSTRUCTION_ACCOUNTS',
  (f) => {
    f.input.transaction.message.instructions[0].accounts = [0, 1, 2, 3, 0];
  },
);

for (const [name, code, mutate] of [
  [
    'transaction object',
    'TRANSACTION',
    (f: Fixture) => {
      f.input.transaction = null;
    },
  ],
  [
    'message object',
    'MESSAGE',
    (f: Fixture) => {
      f.input.transaction.message = [];
    },
  ],
  [
    'key array',
    'ACCOUNT_KEYS',
    (f: Fixture) => {
      f.input.transaction.message.accountKeys = {};
    },
  ],
  [
    'header object',
    'HEADER',
    (f: Fixture) => {
      f.input.transaction.message.header = null;
    },
  ],
  [
    'instruction object',
    'INSTRUCTION',
    (f: Fixture) => {
      f.input.transaction.message.instructions[0] = null;
    },
  ],
  [
    'instruction account array',
    'INSTRUCTION_ACCOUNTS',
    (f: Fixture) => {
      f.input.transaction.message.instructions[0].accounts = null;
    },
  ],
  [
    'inner trace group',
    'CPI_OR_MISSING_TRACE',
    (f: Fixture) => {
      f.input.meta.innerInstructions = [null];
    },
  ],
  [
    'inner trace instruction array',
    'CPI_OR_MISSING_TRACE',
    (f: Fixture) => {
      f.input.meta.innerInstructions = [{ instructions: {} }];
    },
  ],
] as const) {
  negative(`${name} has an explicit shape`, 'SOL', code, mutate);
}

describe('extractSolanaDeposit', () => {
  for (const kind of ['SOL', 'SPL'] as const) {
    /**
     * @target extractSolanaDeposit returns an exact SOL or SPL deposit event
     * @dependencies
     * - canonical fixtures and the real destination validator; no mocks
     * @scenario
     * - extract payment and Memo fixtures for each supported asset kind
     * @expected
     * - event assets, amounts, recipient, and source ID match exactly
     */
    it(`${kind}: payment and canonical Memo produce an exact event`, () => {
      const fixture = makeFixture(kind);
      const result = extractSolanaDeposit(
        fixture.input,
        fixture.config,
        validateErgoAddress,
      );
      expect(result.sourceTxId).toBe(fixture.input.transaction.signatures[0]);
      expect(result.sourceTxId).toBe(sourceTxId);
      expect(result.sourceAsset).toBe(kind === 'SOL' ? 'SOL' : addresses.mint);
      expect(result.sourceAmount).toBe('1000000');
      expect(result.amount).toBe('1000000');
      expect(result.recipientAmount).toBe('999700');
      expect(result.fromAddress).toBe(addresses.sender);
      expect(result.toAddress).toBe(destination);
    });

    /**
     * @target extractSolanaDeposit matches legacy and v0 lookup events
     * @dependencies
     * - makeFixture, withLookup, and both supported asset kinds; no mocks
     * @scenario
     * - extract the same payment with legacy and loaded writable accounts
     * @expected
     * - both account encodings produce deeply equal deposit events
     */
    it(`${kind}: v0 loaded writable account gives the same event`, () => {
      const fixture = withLookup(makeFixture(kind));
      const legacy = makeFixture(kind);
      expect(
        extractSolanaDeposit(
          fixture.input,
          fixture.config,
          validateErgoAddress,
        ),
      ).toEqual(
        extractSolanaDeposit(legacy.input, legacy.config, validateErgoAddress),
      );
    });
  }

  /**
   * @target extractSolanaDeposit rejects every configured negative case
   * @dependencies
   * - negative case tables, fixture mutators, and the rejects helper
   * @scenario
   * - select each row, mutate its fixture, and check the declared error code
   * @expected
   * - each failure is a SolanaDepositError with the row's expected code
   */
  it.each([...negatives, ...additionalNegatives])(
    '$name',
    ({ kind, code, mutate }) => {
      expect.assertions(2);
      const fixture = makeFixture(kind);
      mutate(fixture);
      rejects(fixture, code);
    },
  );

  /**
   * @target extractSolanaDeposit rejects lexical Memo destination boundaries
   * @dependencies
   * - destination boundary values, a fixture, and an accepting validator
   * @scenario
   * - replace the Memo destination with each value and extract the deposit
   * @expected
   * - every boundary value raises the DESTINATION error
   */
  it.each([123, '', 'a'.repeat(257), 'recipient\n'])(
    'destination lexical boundary rejects %j even with an accepting validator',
    (toAddress) => {
      const fixture = makeFixture();
      replaceMemo(fixture.input, { toAddress });
      expect(() =>
        extractSolanaDeposit(fixture.input, fixture.config, () => true),
      ).toThrowError('SolanaDepositError: DESTINATION');
    },
  );

  /**
   * @target extractSolanaDeposit requires a boolean true validator result
   * @dependencies
   * - a canonical fixture and a validator returning a string; no mocks
   * @scenario
   * - extract the fixture with a validator that returns the string true
   * @expected
   * - extraction raises the DESTINATION error
   */
  it('destination validator must return the boolean true', () => {
    const fixture = makeFixture();
    expect(() =>
      extractSolanaDeposit(
        fixture.input,
        fixture.config,
        (() => 'true') as never,
      ),
    ).toThrowError('SolanaDepositError: DESTINATION');
  });

  /**
   * @target extractSolanaDeposit requires a destination validator
   * @dependencies
   * - a canonical fixture and the SolanaDepositError class; no mocks
   * @scenario
   * - call extraction without a validator and inspect the returned error
   * @expected
   * - the error is SolanaDepositError with code DESTINATION_VALIDATOR
   */
  it('requires a destination validator', () => {
    const fixture = makeFixture();
    expect(() =>
      extractSolanaDeposit(fixture.input, fixture.config, undefined as never),
    ).toThrowError(SolanaDepositError);
    try {
      extractSolanaDeposit(fixture.input, fixture.config, undefined as never);
    } catch (error) {
      expect((error as SolanaDepositError).code).toBe('DESTINATION_VALIDATOR');
    }
  });

  /**
   * @target extractSolanaDeposit rejects BOM-prefixed Memo data
   * @dependencies
   * - SOL/SPL fixtures, bs58, and the real destination validator; no mocks
   * @scenario
   * - prefix Memo bytes with a UTF-8 BOM for each asset kind
   * @expected
   * - extraction raises the MEMO_ENCODING error
   */
  it.each(['SOL', 'SPL'] as const)(
    '%s rejects a UTF-8 BOM in Memo bytes',
    (kind) => {
      expect.assertions(2);
      const fixture = makeFixture(kind);
      const instruction = fixture.input.transaction.message.instructions[1];
      instruction.data = bs58.encode(
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          bs58.decode(instruction.data),
        ]),
      );
      rejects(fixture, 'MEMO_ENCODING');
    },
  );

  /**
   * @target extractSolanaDeposit rejects duplicate Memo keys
   * @dependencies
   * - a canonical fixture, bs58, and the rejects helper; no mocks
   * @scenario
   * - add a duplicate JSON key to the Memo and extract the deposit
   * @expected
   * - extraction raises the MEMO_CANONICAL error
   */
  it('rejects duplicate Memo keys that JSON.parse would collapse', () => {
    expect.assertions(2);
    const fixture = makeFixture();
    const instruction = fixture.input.transaction.message.instructions[1];
    const text = Buffer.from(bs58.decode(instruction.data)).toString('utf8');
    instruction.data = bs58.encode(Buffer.from(text.replace('{', '{"v":2,')));
    rejects(fixture, 'MEMO_CANONICAL');
  });

  /**
   * @target extractSolanaDeposit requires an SPL history snapshot
   * @dependencies
   * - an SPL fixture and the rejects helper; no mocks
   * @scenario
   * - remove historical state from the SPL fixture and extract the deposit
   * @expected
   * - extraction raises the HISTORY_BINDING error
   */
  it('rejects a missing SPL historical snapshot', () => {
    expect.assertions(2);
    const fixture = makeFixture('SPL');
    delete fixture.input.history;
    rejects(fixture, 'HISTORY_BINDING');
  });

  /**
   * @target extractSolanaDeposit uses the first transaction signature
   * @dependencies
   * - a canonical fixture and encoded signatures; no mocks
   * @scenario
   * - prepend a signature and matching account balances to the transaction
   * @expected
   * - the result source ID equals the first transaction signature
   */
  it('preserves the first transaction signature as the source ID', () => {
    const fixture = makeFixture();
    const first = bs58.encode(Buffer.alloc(64, 22));
    fixture.input.transaction.signatures = [first, sourceTxId];
    fixture.input.transaction.message.header.numRequiredSignatures = 2;
    const message = fixture.input.transaction.message;
    message.accountKeys.unshift(addresses.sponsor);
    for (const instruction of message.instructions) {
      instruction.programIdIndex++;
      instruction.accounts = instruction.accounts.map(
        (index: number) => index + 1,
      );
    }
    fixture.input.meta.preBalances.unshift('10000');
    fixture.input.meta.postBalances.unshift('5000');
    fixture.input.meta.preBalances[1] = '2000000';
    expect(
      extractSolanaDeposit(fixture.input, fixture.config, validateErgoAddress)
        .sourceTxId,
    ).toBe(first);
  });

  /**
   * @target extractSolanaDeposit enforces the Ergo signed amount maximum
   * @dependencies
   * - a fixture, transferBytes, replaceMemo, and BigInt; no mocks
   * @scenario
   * - extract the signed maximum, then extract maximum plus one
   * @expected
   * - the maximum is accepted and the larger value raises ERGO_RANGE
   */
  it('accepts the Ergo signed maximum and rejects maximum plus one', () => {
    const fixture = makeFixture();
    const maximum = (1n << 63n) - 1n;
    const transfer = fixture.input.transaction.message.instructions[0];
    transfer.data = transferBytes('SOL', maximum);
    replaceMemo(fixture.input, {
      amount: maximum.toString(),
      networkFee: '100',
      bridgeFee: '200',
    });
    fixture.input.meta.preBalances[0] = (maximum + 5001n).toString();
    fixture.input.meta.postBalances[0] = '1';
    fixture.input.meta.preBalances[1] = '0';
    fixture.input.meta.postBalances[1] = maximum.toString();
    expect(
      extractSolanaDeposit(fixture.input, fixture.config, validateErgoAddress)
        .amount,
    ).toBe(maximum.toString());

    transfer.data = transferBytes('SOL', maximum + 1n);
    replaceMemo(fixture.input, {
      amount: (maximum + 1n).toString(),
      networkFee: '100',
      bridgeFee: '200',
    });
    fixture.input.meta.preBalances[0] = (maximum + 5002n).toString();
    fixture.input.meta.postBalances[1] = (maximum + 1n).toString();
    rejects(fixture, 'ERGO_RANGE');
  });
});
