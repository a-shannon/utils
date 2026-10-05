import bs58 from 'bs58';
import { Address, NetworkPrefix } from 'ergo-lib-wasm-nodejs';
import { describe, expect, it } from 'vitest';

import { SOLANA_TOKEN_PROGRAM_ID } from '@rosen-bridge/address-codec-solana';
import { TokenMap } from '@rosen-bridge/tokens';

import {
  ERGO_CHAIN,
  SOLANA_CHAIN,
  SOLANA_NATIVE_TOKEN,
} from '../../../lib/getRosenData/const';
import { decodeSolanaHistoryAccount } from '../../../lib/getRosenData/solana/historyAccountDecoder';
import { SolanaRosenExtractor } from '../../../lib/getRosenData/solana/solanaRosenExtractor';
import {
  addresses,
  destination,
  makeFixture,
  replaceMemo,
  transferBytes,
  withLookup,
} from './testData';

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

/** Build a TokenMap entry describing a wrapped Ergo asset. */
const ergoToken = (tokenId: string, decimals: number) => ({
  tokenId,
  name: 'wrapped test token',
  decimals,
  type: 'EIP-004',
  residency: 'wrapped',
  extra: {},
});

/** Build a TokenMap entry describing an asset on a source chain. */
const chainToken = (
  tokenId: string,
  name: string,
  decimals: number,
  residency = 'native',
) => ({ tokenId, name, decimals, type: 'native', residency, extra: {} });

/** Encode the fixture destination with the requested Ergo network prefix. */
const ergoAddressForNetwork = (network: 'mainnet' | 'testnet'): string => {
  const parsed = Address.from_mainnet_str(destination);
  try {
    return parsed.to_base58(
      network === 'mainnet' ? NetworkPrefix.Mainnet : NetworkPrefix.Testnet,
    );
  } finally {
    parsed.free();
  }
};

/** Create a TokenMap containing the native and SPL Solana fixture assets. */
const makeTokenMap = async (): Promise<TokenMap> => {
  const tokenMap = new TokenMap();
  await tokenMap.updateConfigByJson([
    {
      [ERGO_CHAIN]: ergoToken('cd'.repeat(32), 9),
      [SOLANA_CHAIN]: chainToken(SOLANA_NATIVE_TOKEN, 'SOL', 9),
    },
    {
      [ERGO_CHAIN]: ergoToken('ab'.repeat(32), 9),
      [SOLANA_CHAIN]: chainToken(addresses.mint, 'Test SPL', 6),
      cardano: chainToken('fixture-cardano-token', 'Cardano representation', 3),
    },
  ]);
  return tokenMap;
};

/** Create the extractor configuration used by the SOL and SPL fixtures. */
const makeExtractorConfig = () => ({
  clusterGenesisHash: addresses.genesis,
  destinationNetwork: 'mainnet',
  vaultOwner: addresses.vault,
  assets: {
    SOL: {
      minAmount: '1',
      maxAmount: '18446744073709551615',
      networkFee: '100',
      bridgeFee: '200',
    },
    [addresses.mint]: {
      minAmount: '1',
      maxAmount: '18446744073709551615',
      networkFee: '1000',
      bridgeFee: '2000',
      vaultTokenAccount: addresses.vaultToken,
    },
  },
});

/** Create a Solana extractor with the supplied or fixture TokenMap. */
const makeExtractor = async (tokenMap?: TokenMap, storeRawData = true) => {
  const configuredTokenMap = tokenMap ?? (await makeTokenMap());
  return new SolanaRosenExtractor(
    makeExtractorConfig(),
    configuredTokenMap,
    undefined,
    storeRawData,
  );
};

describe('SolanaRosenExtractor', () => {
  describe('constructor', () => {
    /**
     * @target SolanaRosenExtractor.constructor rejects absent or ambiguous
     *   configured token mappings
     * @dependencies
     * - TokenMap and extractor configuration; no mocks
     * @scenario
     * - construct with a missing entry, duplicate mapping, and shared
     *   destination token
     * @expected
     * - each invalid mapping is rejected with its mapping error
     */
    it('constructor rejects absent or ambiguous configured token mappings', async () => {
      const incomplete = new TokenMap();
      await incomplete.updateConfigByJson([
        {
          [ERGO_CHAIN]: ergoToken('cd'.repeat(32), 9),
          [SOLANA_CHAIN]: chainToken(SOLANA_NATIVE_TOKEN, 'SOL', 9),
        },
      ]);
      expect(
        () => new SolanaRosenExtractor(makeExtractorConfig(), incomplete),
      ).toThrow(/tokenMapping/);

      const ambiguous = await makeTokenMap();
      const entries = ambiguous.getConfig();
      await ambiguous.updateConfigByJson([
        ...entries,
        structuredClone(entries[0]),
      ]);
      expect(
        () => new SolanaRosenExtractor(makeExtractorConfig(), ambiguous),
      ).toThrow(/tokenMapping/);

      const sharedDestination = new TokenMap();
      await sharedDestination.updateConfigByJson([
        {
          [ERGO_CHAIN]: ergoToken('cd'.repeat(32), 9),
          [SOLANA_CHAIN]: chainToken(SOLANA_NATIVE_TOKEN, 'SOL', 9),
        },
        {
          [ERGO_CHAIN]: ergoToken('cd'.repeat(32), 9),
          [SOLANA_CHAIN]: chainToken(addresses.mint, 'Test SPL', 6),
        },
      ]);
      expect(
        () =>
          new SolanaRosenExtractor(makeExtractorConfig(), sharedDestination),
      ).toThrow(/ambiguous token ID/);
    });

    /**
     * @target SolanaRosenExtractor.constructor rejects malformed policy before
     *   transaction projection
     * @dependencies
     * - TokenMap and extractor configuration; no mocks
     * @scenario
     * - set invalid amount bounds and fee dust, then construct the extractor
     * @expected
     * - each policy is rejected with its configuration error
     */
    it('constructor rejects malformed policy before transaction projection', async () => {
      const config = makeExtractorConfig();
      config.assets.SOL.maxAmount = '2';
      const tokens = await makeTokenMap();
      expect(() => new SolanaRosenExtractor(config, tokens)).toThrow(
        /assets\.SOL\.amounts/,
      );

      const feeDust = makeExtractorConfig();
      feeDust.assets[addresses.mint].networkFee = '1001';
      expect(() => new SolanaRosenExtractor(feeDust, tokens)).toThrow(
        /assets\..*\.fees/,
      );
    });

    /**
     * @target SolanaRosenExtractor.constructor rejects a configured SPL token
     *   absent from TokenMap
     * @dependencies
     * - TokenMap and extractor configuration; no mocks
     * @scenario
     * - configure an SPL mint without its TokenMap entry and construct the
     *   extractor
     * @expected
     * - construction throws a tokenMapping error
     */
    it('constructor rejects a configured SPL token absent from TokenMap', async () => {
      const tokenMap = new TokenMap();
      await tokenMap.updateConfigByJson([
        {
          [ERGO_CHAIN]: ergoToken('cd'.repeat(32), 9),
          [SOLANA_CHAIN]: chainToken(SOLANA_NATIVE_TOKEN, 'SOL', 9),
        },
      ]);
      expect(
        () => new SolanaRosenExtractor(makeExtractorConfig(), tokenMap),
      ).toThrow(/tokenMapping/);
    });
  });

  describe('get', () => {
    /**
     * @target SolanaRosenExtractor.get normalizes v0 lookup indices and history
     *   for %s
     * @dependencies
     * - lookup fixture helper, TokenMap, and optional SPL history; no mocks
     * @scenario
     * - build a v0 lookup fixture for each asset and call get()
     * @expected
     * - native and SPL amounts use their finalized Rosen units
     */
    it.each(['SOL', 'SPL'] as const)(
      'get normalizes v0 lookup indices and history for %s',
      async (kind) => {
        const extractor = await makeExtractor();
        const fixture = withLookup(makeFixture(kind));
        if (kind === 'SPL')
          replaceMemo(fixture.input, { networkFee: '1000', bridgeFee: '2000' });
        expect(extractor.get(JSON.stringify(fixture.input))?.amount).toBe(
          kind === 'SOL' ? '1000000' : '1000',
        );
      },
    );

    /**
     * @target SolanaRosenExtractor.get produces RosenData for a finalized
     *   native SOL deposit
     * @dependencies
     * - SOL fixture helper and TokenMap; no mocks
     * @scenario
     * - call get() with a finalized native SOL fixture
     * @expected
     * - RosenData contains destination, fees, token IDs, amount, source ID, and
     *   Memo
     */
    it('get produces RosenData for a finalized native SOL deposit', async () => {
      const extractor = await makeExtractor();
      const fixture = makeFixture('SOL');
      const result = extractor.get(JSON.stringify(fixture.input));

      expect(result).toMatchObject({
        toChain: 'ergo',
        toAddress: destination,
        bridgeFee: '200',
        networkFee: '100',
        fromAddress: addresses.sender,
        sourceChainTokenId: SOLANA_NATIVE_TOKEN,
        amount: '1000000',
        targetChainTokenId: 'cd'.repeat(32),
        sourceTxId: fixture.input.transaction.signatures[0],
        rawData: fixture.input.transaction.message.instructions[1].data,
      });
    });

    /**
     * @target SolanaRosenExtractor.get uses minimum TokenMap decimals for SPL
     *   and maps fees exactly
     * @dependencies
     * - SPL fixture helper and TokenMap entries across chains; no mocks
     * @scenario
     * - call get() for SPL with configured fees and differing chain decimals
     * @expected
     * - amount and fees use the minimum destination scale exactly
     */
    it('get uses minimum TokenMap decimals for SPL and maps fees exactly', async () => {
      const extractor = await makeExtractor();
      const fixture = makeFixture('SPL');
      replaceMemo(fixture.input, {
        networkFee: '1000',
        bridgeFee: '2000',
      });

      const result = extractor.get(JSON.stringify(fixture.input));

      expect(result).toMatchObject({
        bridgeFee: '2',
        networkFee: '1',
        sourceChainTokenId: addresses.mint,
        amount: '1000',
        targetChainTokenId: 'ab'.repeat(32),
      });
    });

    /**
     * @target SolanaRosenExtractor.get refuses mapping dust before TokenMap
     *   rounds it upward
     * @dependencies
     * - SPL fixture history, transfer encoder, and TokenMap; no mocks
     * @scenario
     * - set transfer/history deltas one source unit above a representable
     *   amount and call get()
     * @expected
     * - get() returns undefined for mapping dust
     */
    it('get refuses mapping dust before TokenMap rounds it upward', async () => {
      const extractor = await makeExtractor();
      const fixture = makeFixture('SPL');
      const amount = '1000001';
      fixture.input.transaction.message.instructions[0].data = transferBytes(
        'SPL',
        amount,
      );
      replaceMemo(fixture.input, {
        amount,
        networkFee: '1000',
        bridgeFee: '2000',
      });
      fixture.input.history.source.post.amount = '999999';
      fixture.input.history.vault.post.amount = amount;
      fixture.input.meta.postTokenBalances[0].uiTokenAmount.amount = '999999';
      fixture.input.meta.postTokenBalances[1].uiTokenAmount.amount = amount;

      expect(extractor.get(JSON.stringify(fixture.input))).toBeUndefined();
    });

    /**
     * @target SolanaRosenExtractor.get accepts fractional RPC display balances
     *   without using them as amounts
     * @dependencies
     * - SPL fixture history and RPC display metadata; no mocks
     * @scenario
     * - provide fractional uiAmount display values while integer history
     *   carries transfer amounts
     * @expected
     * - get() derives the amount from integer history and returns the expected
     *   Rosen amount
     */
    it('get accepts fractional RPC display balances without using them as amounts', async () => {
      const extractor = await makeExtractor();
      const fixture = makeFixture('SPL');
      replaceMemo(fixture.input, { networkFee: '1000', bridgeFee: '2000' });
      fixture.input.history.source.pre.amount = '2500000';
      fixture.input.history.source.post.amount = '1500000';
      for (const [field, amount, uiAmount] of [
        ['preTokenBalances', '2500000', 2.5],
        ['postTokenBalances', '1500000', 1.5],
      ] as const) {
        fixture.input.meta[field][0].uiTokenAmount = {
          amount,
          decimals: 6,
          uiAmount,
          uiAmountString: String(uiAmount),
        };
      }

      expect(extractor.get(JSON.stringify(fixture.input))?.amount).toBe('1000');
    });

    /**
     * @target SolanaRosenExtractor.get rejects duplicate RPC keys before
     *   projection
     * @dependencies
     * - SOL fixture and raw serialized RPC JSON; no mocks
     * @scenario
     * - duplicate the fee key in serialized JSON and call get()
     * @expected
     * - get() returns undefined
     */
    it('get rejects duplicate RPC keys before projection', async () => {
      const extractor = await makeExtractor();
      const serialized = JSON.stringify(makeFixture('SOL').input).replace(
        '"fee":"5000"',
        '"fee":"0","fee":"5000"',
      );
      expect(extractor.get(serialized)).toBeUndefined();
    });

    /**
     * @target SolanaRosenExtractor.get rejects fractional or unsafe numeric RPC
     *   fees: %s
     * @dependencies
     * - SOL fixture and raw serialized RPC JSON; no mocks
     * @scenario
     * - substitute each fractional or exponent fee token and call get()
     * @expected
     * - get() returns undefined for each noncanonical fee
     */
    it.each([
      '5000.5',
      '5000.0000000000000001',
      '9.9999999999e18',
      '5000.0',
      '5e3',
    ])('get rejects fractional or unsafe numeric RPC fees: %s', async (fee) => {
      const extractor = await makeExtractor();
      const serialized = JSON.stringify(makeFixture('SOL').input).replace(
        '"fee":"5000"',
        `"fee":${fee}`,
      );
      expect(extractor.get(serialized)).toBeUndefined();
    });

    /**
     * @target SolanaRosenExtractor.get rejects an exponent balance that could
     *   hide excess credit
     * @dependencies
     * - SOL fixture and raw serialized RPC JSON; no mocks
     * @scenario
     * - replace a wide integer balance with its exponent form and call get()
     * @expected
     * - get() returns undefined
     */
    it('get rejects an exponent balance that could hide excess credit', async () => {
      const extractor = await makeExtractor();
      const fixture = makeFixture('SOL');
      fixture.input.meta.preBalances[1] = '9999999999900000000';
      fixture.input.meta.postBalances[1] = '9999999999901000256';
      const serialized = JSON.stringify(fixture.input).replace(
        '"9999999999900000000"',
        '9.9999999999e18',
      );
      expect(extractor.get(serialized)).toBeUndefined();
    });

    /**
     * @target SolanaRosenExtractor.get rejects underflowing numeric balances
     *   instead of treating them as zero: %s
     * @dependencies
     * - SOL fixture and raw serialized RPC JSON; no mocks
     * @scenario
     * - substitute each underflowing exponent balance and call get()
     * @expected
     * - get() returns undefined for each token
     */
    it.each(['1e-400', '-1e-400'])(
      'get rejects underflowing numeric balances instead of treating them as zero: %s',
      async (tiny) => {
        const extractor = await makeExtractor();
        const fixture = makeFixture('SOL');
        fixture.input.meta.preBalances[1] = '0';
        fixture.input.meta.postBalances[1] = '1000000';
        const serialized = JSON.stringify(fixture.input).replace(
          '"preBalances":["2005000","0"',
          `"preBalances":["2005000",${tiny}`,
        );
        expect(extractor.get(serialized)).toBeUndefined();
      },
    );

    /**
     * @target SolanaRosenExtractor.get rejects noncanonical numeric account
     *   indices: %s
     * @dependencies
     * - SOL fixture and raw serialized RPC JSON; no mocks
     * @scenario
     * - substitute each noncanonical index token and call get()
     * @expected
     * - get() returns undefined for each token
     */
    it.each(['1e-400', '-1e-400', '-0', '0.0', '0e0'])(
      'get rejects noncanonical numeric account indices: %s',
      async (index) => {
        const extractor = await makeExtractor();
        const serialized = JSON.stringify(makeFixture('SOL').input).replace(
          '"accounts":[0,1]',
          `"accounts":[${index},1]`,
        );
        expect(extractor.get(serialized)).toBeUndefined();
      },
    );

    /**
     * @target SolanaRosenExtractor.get preserves wide RPC integer tokens before
     *   normalization
     * @dependencies
     * - TokenMap, SOL fixture, and raw serialized RPC integer tokens; no mocks
     * @scenario
     * - encode an amount above the safe integer limit and call get()
     * @expected
     * - RosenData retains the exact wide amount
     */
    it('get preserves wide RPC integer tokens before normalization', async () => {
      const tokenMap = new TokenMap();
      await tokenMap.updateConfigByJson([
        {
          [ERGO_CHAIN]: ergoToken('cd'.repeat(32), 9),
          [SOLANA_CHAIN]: chainToken(SOLANA_NATIVE_TOKEN, 'SOL', 9),
        },
        {
          [ERGO_CHAIN]: ergoToken('ab'.repeat(32), 9),
          [SOLANA_CHAIN]: chainToken(addresses.mint, 'Test SPL', 6),
        },
      ]);
      const extractor = await makeExtractor(tokenMap);
      const fixture = makeFixture('SOL');
      const amount = '9007199254740993';
      const sourceBefore = (BigInt(amount) + 5000n).toString();
      fixture.input.transaction.message.instructions[0].data = transferBytes(
        'SOL',
        amount,
      );
      replaceMemo(fixture.input, { amount });
      fixture.input.meta.preBalances[0] = sourceBefore;
      fixture.input.meta.postBalances[0] = '0';
      fixture.input.meta.preBalances[1] = '0';
      fixture.input.meta.postBalances[1] = amount;
      const serialized = JSON.stringify(fixture.input)
        .replace(`"${sourceBefore}"`, sourceBefore)
        .replace(`"${amount}"`, amount);

      expect(extractor.get(serialized)?.amount).toBe(amount);
    });
  });

  describe('getWithContext', () => {
    /**
     * @target SolanaRosenExtractor.getWithContext returns finalized Rosen units
     *   and source context for %s
     * @dependencies
     * - fixture helpers and TokenMap provide native/SPL inputs; no mocks
     * @scenario
     * - build each fixture, project it through getWithContext, and compare data
     *   with get() plus source context
     * @expected
     * - contextual outcome is a deposit with the same RosenData as get()
     */
    it.each(['SOL', 'SPL'] as const)(
      'getWithContext returns finalized Rosen units and source context for %s',
      async (kind) => {
        const extractor = await makeExtractor();
        const fixture = makeFixture(kind);
        if (kind === 'SPL')
          replaceMemo(fixture.input, { networkFee: '1000', bridgeFee: '2000' });
        const serialized = JSON.stringify(fixture.input);

        const outcome = extractor.getWithContext(serialized);

        expect(outcome.type).toBe('deposit');
        if (outcome.type !== 'deposit') throw new Error('Expected deposit');
        expect(outcome.data).toEqual(extractor.get(serialized));
        expect(outcome.context).toEqual({
          clusterGenesisHash: fixture.input.clusterGenesisHash,
          sourceTxId: fixture.input.transaction.signatures[0],
          sourceSlot: fixture.input.slot,
          sourceBlockhash: fixture.input.blockhash,
        });
      },
    );

    describe('binary history joined to SolanaRosenExtractor', () => {
      /** Build a TokenMap entry for a wrapped Ergo asset in the binary-history fixture. */
      const ergoToken = (tokenId: string, decimals: number) => ({
        tokenId,
        name: 'wrapped test token',
        decimals,
        type: 'EIP-004',
        residency: 'wrapped',
        extra: {},
      });

      /** Build a TokenMap entry for a Solana asset in the binary-history fixture. */
      const chainToken = (tokenId: string, name: string, decimals: number) => ({
        tokenId,
        name,
        decimals,
        type: 'native',
        residency: 'native',
        extra: {},
      });

      /** Create an extractor whose TokenMap accepts the binary-history fixtures. */
      const makeExtractor = async (): Promise<SolanaRosenExtractor> => {
        const tokenMap = new TokenMap();
        await tokenMap.updateConfigByJson([
          {
            [ERGO_CHAIN]: ergoToken('cd'.repeat(32), 9),
            [SOLANA_CHAIN]: chainToken(SOLANA_NATIVE_TOKEN, 'SOL', 9),
          },
          {
            [ERGO_CHAIN]: ergoToken('ab'.repeat(32), 9),
            [SOLANA_CHAIN]: chainToken(addresses.mint, 'Test SPL', 6),
          },
        ]);
        return new SolanaRosenExtractor(
          {
            clusterGenesisHash: addresses.genesis,
            destinationNetwork: 'mainnet',
            vaultOwner: addresses.vault,
            assets: {
              SOL: {
                minAmount: '1',
                maxAmount: '18446744073709551615',
                networkFee: '100',
                bridgeFee: '200',
              },
              [addresses.mint]: {
                minAmount: '1',
                maxAmount: '18446744073709551615',
                networkFee: '1000',
                bridgeFee: '2000',
                vaultTokenAccount: addresses.vaultToken,
              },
            },
          },
          tokenMap,
        );
      };

      /** Decode one token-account state and place it in the requested history slot. */
      const setTokenSnapshot = (
        history: Record<string, any>,
        side: 'source' | 'vault',
        phase: 'pre' | 'post',
        options: Parameters<typeof packTokenAccount>[0],
      ): void => {
        const address =
          side === 'source' ? addresses.sourceToken : addresses.vaultToken;
        const owner = side === 'source' ? addresses.sender : addresses.vault;
        const decoded = decodeSolanaHistoryAccount(
          record(
            address,
            packTokenAccount({
              mint: addresses.mint,
              owner,
              ...options,
            }),
          ),
        );
        if (decoded.kind !== 'token-account')
          throw new Error('Expected token account');
        history[side][phase] = decoded;
      };

      /** Populate mint, source, and vault history with decoded SPL account bytes. */
      const binaryHistory = (fixture: ReturnType<typeof makeFixture>): void => {
        const history = fixture.input.history as Record<string, any>;
        const mint = decodeSolanaHistoryAccount(
          record(addresses.mint, packMint()),
        );
        if (mint.kind !== 'mint') throw new Error('Expected mint account');
        history.mint = {
          address: mint.address,
          pre: mint,
          post: mint,
        };
        setTokenSnapshot(history, 'source', 'pre', { amount: 2_000_000n });
        setTokenSnapshot(history, 'source', 'post', { amount: 1_000_000n });
        setTokenSnapshot(history, 'vault', 'pre', {
          owner: addresses.vault,
          amount: 0n,
        });
        setTokenSnapshot(history, 'vault', 'post', {
          owner: addresses.vault,
          amount: 1_000_000n,
        });
      };

      /**
       * @target SolanaRosenExtractor.getWithContext: consume decoded history.
       * @dependencies Binary SPL history, mainnet destination, and SOL fixture.
       * @scenario Submit decoded SPL history and a valid SOL deposit.
       * @expected Accept both deposits and return SPL source context fields.
       */
      it('feeds decoded SPL bytes to the real mainnet extractor and keeps SOL accepted', async () => {
        const mainnetAddress = Address.from_mainnet_str(destination);
        try {
          expect(mainnetAddress.to_base58(NetworkPrefix.Mainnet)).toBe(
            destination,
          );
        } finally {
          mainnetAddress.free();
        }

        const extractor = await makeExtractor();
        const spl = makeFixture('SPL');
        replaceMemo(spl.input, { networkFee: '1000', bridgeFee: '2000' });
        binaryHistory(spl);
        const outcome = extractor.getWithContext(JSON.stringify(spl.input));

        expect(outcome.type).toBe('deposit');
        if (outcome.type !== 'deposit') throw new Error('Expected SPL deposit');
        expect(outcome.data).toMatchObject({
          sourceChainTokenId: addresses.mint,
          amount: '1000000',
          targetChainTokenId: 'ab'.repeat(32),
        });
        expect(outcome.context).toEqual({
          clusterGenesisHash: addresses.genesis,
          sourceTxId: spl.input.transaction.signatures[0],
          sourceSlot: spl.input.slot,
          sourceBlockhash: spl.input.blockhash,
        });

        const sol = makeFixture('SOL');
        const solOutcome = extractor.getWithContext(JSON.stringify(sol.input));
        expect(solOutcome.type).toBe('deposit');
      });

      /**
       * @target SolanaRosenExtractor.getWithContext: validate vault authority.
       * @dependencies Decoded vault snapshots with delegate or close authority.
       * @scenario Submit each mutated vault token-account history.
       * @expected Reject both histories through the VAULT_AUTHORITY check.
       */
      it.each([
        ['delegate', { delegate: addresses.sender, closeAuthority: null }],
        [
          'close authority',
          { delegate: null, closeAuthority: addresses.sponsor },
        ],
      ])(
        'rejects a vault %s through the VAULT_AUTHORITY check',
        async (_name, options) => {
          const extractor = await makeExtractor();
          const fixture = makeFixture('SPL');
          replaceMemo(fixture.input, { networkFee: '1000', bridgeFee: '2000' });
          binaryHistory(fixture);
          setTokenSnapshot(fixture.input.history, 'vault', 'pre', {
            owner: addresses.vault,
            amount: 0n,
            ...(options as {
              delegate: string | null;
              closeAuthority: string | null;
            }),
          });

          expect(
            extractor.getWithContext(JSON.stringify(fixture.input)),
          ).toMatchObject({
            reason: 'VAULT_AUTHORITY',
          });
        },
      );

      /**
       * @target SolanaRosenExtractor.getWithContext: validate token amount delta.
       * @dependencies Decoded SPL history with a changed source amount.
       * @scenario Submit history whose source amount differs by one unit.
       * @expected Reject the deposit through the TOKEN_DELTA check.
       */
      it('routes a decoded source amount mutation to the existing token-delta check', async () => {
        const extractor = await makeExtractor();
        const fixture = makeFixture('SPL');
        replaceMemo(fixture.input, { networkFee: '1000', bridgeFee: '2000' });
        binaryHistory(fixture);
        setTokenSnapshot(fixture.input.history, 'source', 'post', {
          amount: 999_999n,
        });

        expect(
          extractor.getWithContext(JSON.stringify(fixture.input)),
        ).toMatchObject({
          reason: 'TOKEN_DELTA',
        });
      });

      /**
       * @target SolanaRosenExtractor.getWithContext: validate mint and owner data.
       * @dependencies Decoded mint snapshots and source token-account history.
       * @scenario Submit changed mint decimals and a changed source token owner.
       * @expected Reject them through MINT_HISTORY and TOKEN_STATE checks.
       */
      it('routes decoded mint and token-owner mutations to their existing checks', async () => {
        const extractor = await makeExtractor();
        const mintFixture = makeFixture('SPL');
        replaceMemo(mintFixture.input, {
          networkFee: '1000',
          bridgeFee: '2000',
        });
        const mint = decodeSolanaHistoryAccount(
          record(addresses.mint, packMint({ decimals: 7 })),
        );
        if (mint.kind !== 'mint') throw new Error('Expected mint account');
        binaryHistory(mintFixture);
        mintFixture.input.history.mint.pre = mint;
        mintFixture.input.history.mint.post = mint;
        expect(
          extractor.getWithContext(JSON.stringify(mintFixture.input)),
        ).toMatchObject({ reason: 'MINT_HISTORY' });

        const ownerFixture = makeFixture('SPL');
        replaceMemo(ownerFixture.input, {
          networkFee: '1000',
          bridgeFee: '2000',
        });
        binaryHistory(ownerFixture);
        setTokenSnapshot(ownerFixture.input.history, 'source', 'pre', {
          owner: addresses.sponsor,
          amount: 2_000_000n,
        });
        expect(
          extractor.getWithContext(JSON.stringify(ownerFixture.input)),
        ).toMatchObject({ reason: 'TOKEN_STATE' });
      });
    });

    /**
     * @target SolanaRosenExtractor.getWithContext rejects a testnet Ergo
     *   address under a mainnet profile
     * @dependencies
     * - fixture helpers, Address network conversion, and configured mainnet
     *   profile; no mocks
     * @scenario
     * - replace the Memo destination with a testnet address and project the
     *   transaction
     * @expected
     * - outcome is not-deposit with reason DESTINATION
     */
    it('getWithContext rejects a testnet Ergo address under a mainnet profile', async () => {
      const extractor = await makeExtractor();
      const fixture = makeFixture('SOL');
      replaceMemo(fixture.input, {
        toAddress: ergoAddressForNetwork('testnet'),
      });

      expect(extractor.getWithContext(JSON.stringify(fixture.input))).toEqual({
        type: 'not-deposit',
        reason: 'DESTINATION',
      });
    });

    /**
     * @target SolanaRosenExtractor.getWithContext accepts a canonical testnet
     *   Ergo address under a testnet profile
     * @dependencies
     * - fixture helpers, Address network conversion, and TokenMap; no mocks
     * @scenario
     * - configure testnet, set a canonical testnet Memo address, and project
     *   the transaction
     * @expected
     * - contextual projection is a deposit and get() returns that address
     */
    it('getWithContext accepts a canonical testnet Ergo address under a testnet profile', async () => {
      const config = makeExtractorConfig();
      config.destinationNetwork = 'testnet';
      const extractor = new SolanaRosenExtractor(config, await makeTokenMap());
      const fixture = makeFixture('SOL');
      fixture.input.destinationNetwork = 'testnet';
      const testnetAddress = ergoAddressForNetwork('testnet');
      replaceMemo(fixture.input, { toAddress: testnetAddress });
      const serialized = JSON.stringify(fixture.input);

      const contextual = extractor.getWithContext(serialized);

      expect(contextual.type).toBe('deposit');
      expect(extractor.get(serialized)?.toAddress).toBe(testnetAddress);
    });

    /**
     * @target SolanaRosenExtractor.getWithContext reports a complete CPI
     *   transaction as not-deposit
     * @dependencies
     * - fixture helpers and extractor; no mocks
     * @scenario
     * - add an inner instruction trace to a valid fixture and project it
     * @expected
     * - outcome is not-deposit with reason CPI_OR_MISSING_TRACE
     */
    it('getWithContext reports a complete CPI transaction as not-deposit', async () => {
      const extractor = await makeExtractor();
      const fixture = makeFixture('SOL');
      fixture.input.meta.innerInstructions = [{ index: 0, instructions: [{}] }];

      expect(extractor.getWithContext(JSON.stringify(fixture.input))).toEqual({
        type: 'not-deposit',
        reason: 'CPI_OR_MISSING_TRACE',
      });
    });

    /**
     * @target SolanaRosenExtractor.getWithContext holds an SPL deposit when
     *   required history is unavailable
     * @dependencies
     * - SPL fixture helpers and extractor; no mocks
     * @scenario
     * - remove history from a plausible SPL fixture and project it
     * @expected
     * - outcome is unavailable with reason HISTORY_BINDING
     */
    it('getWithContext holds an SPL deposit when required history is unavailable', async () => {
      const extractor = await makeExtractor();
      const fixture = makeFixture('SPL');
      replaceMemo(fixture.input, { networkFee: '1000', bridgeFee: '2000' });
      delete fixture.input.history;

      expect(extractor.getWithContext(JSON.stringify(fixture.input))).toEqual({
        type: 'unavailable',
        reason: 'HISTORY_BINDING',
      });
    });

    /**
     * @target SolanaRosenExtractor.getWithContext reports a transfer of an
     *   unsupported mint as not-deposit
     * @dependencies
     * - SPL fixture helpers and configured asset policy; no mocks
     * @scenario
     * - replace the fixture mint with an unsupported account and project it
     * @expected
     * - outcome is not-deposit with reason UNSUPPORTED_ASSET
     */
    it('getWithContext reports a transfer of an unsupported mint as not-deposit', async () => {
      const extractor = await makeExtractor();
      const fixture = makeFixture('SPL');
      fixture.input.transaction.message.accountKeys[3] = addresses.sponsor;

      expect(extractor.getWithContext(JSON.stringify(fixture.input))).toEqual({
        type: 'not-deposit',
        reason: 'UNSUPPORTED_ASSET',
      });
    });

    /**
     * @target SolanaRosenExtractor.getWithContext classifies unsupported System
     *   and Token opcodes
     * @dependencies
     * - SOL/SPL fixture helpers and base58 instruction encoding; no mocks
     * @scenario
     * - encode unsupported System and Token opcodes and project both fixtures
     * @expected
     * - outcomes report SYSTEM_TRANSFER and TOKEN_TRANSFER_CHECKED
     */
    it('getWithContext classifies unsupported System and Token opcodes', async () => {
      const extractor = await makeExtractor();
      const system = makeFixture('SOL');
      system.input.transaction.message.instructions[0].data = bs58.encode(
        Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.alloc(8)]),
      );
      const token = makeFixture('SPL');
      token.input.transaction.message.instructions[0].data = bs58.encode(
        Buffer.concat([Buffer.from([3]), Buffer.alloc(9)]),
      );

      expect(extractor.getWithContext(JSON.stringify(system.input))).toEqual({
        type: 'not-deposit',
        reason: 'SYSTEM_TRANSFER',
      });
      expect(extractor.getWithContext(JSON.stringify(token.input))).toEqual({
        type: 'not-deposit',
        reason: 'TOKEN_TRANSFER_CHECKED',
      });
    });

    /**
     * @target SolanaRosenExtractor.getWithContext holds an incomplete RPC
     *   envelope
     * @dependencies
     * - SOL fixture helper and extractor; no mocks
     * @scenario
     * - remove loaded-address metadata from a candidate fixture and project it
     * @expected
     * - outcome is unavailable with reason INCOMPLETE_RPC_ENVELOPE
     */
    it('getWithContext holds an incomplete RPC envelope', async () => {
      const extractor = await makeExtractor();
      const fixture = makeFixture('SOL');
      delete fixture.input.meta.loadedAddresses;

      expect(extractor.getWithContext(JSON.stringify(fixture.input))).toEqual({
        type: 'unavailable',
        reason: 'INCOMPLETE_RPC_ENVELOPE',
      });
    });

    /**
     * @target SolanaRosenExtractor.getWithContext ignores non-candidate traffic
     *   without deposit metadata
     * @dependencies
     * - SOL fixture helper and extractor; no mocks
     * @scenario
     * - remove the Memo instruction and optional metadata, then project the
     *   fixture
     * @expected
     * - outcome is not-deposit with reason NOT_BRIDGE_INSTRUCTION_PAIR
     */
    it('getWithContext ignores non-candidate traffic without deposit metadata', async () => {
      const extractor = await makeExtractor();
      const fixture = makeFixture('SOL');
      fixture.input.transaction.message.instructions.pop();
      delete fixture.input.meta.innerInstructions;
      delete fixture.input.meta.loadedAddresses;

      expect(extractor.getWithContext(JSON.stringify(fixture.input))).toEqual({
        type: 'not-deposit',
        reason: 'NOT_BRIDGE_INSTRUCTION_PAIR',
      });
    });

    /**
     * @target SolanaRosenExtractor.getWithContext keeps the accepted Memo when
     *   generic raw storage is off
     * @dependencies
     * - SOL fixture helper and extractor configured without generic raw
     *   storage; no mocks
     * @scenario
     * - compare get() and getWithContext() rawData for the same accepted
     *   fixture
     * @expected
     * - generic get() redacts rawData while contextual output retains the Memo
     */
    it('getWithContext keeps the accepted Memo when generic raw storage is off', async () => {
      const extractor = await makeExtractor(undefined, false);
      const fixture = makeFixture('SOL');
      const serialized = JSON.stringify(fixture.input);
      const generic = extractor.get(serialized);
      const contextual = extractor.getWithContext(serialized);

      expect(generic?.rawData).toBe('raw-data extraction is off');
      expect(contextual.type).toBe('deposit');
      if (contextual.type !== 'deposit') throw new Error('Expected deposit');
      expect(contextual.data.rawData).toBe(
        fixture.input.transaction.message.instructions[1].data,
      );
    });
  });

  describe('getBlockWithContext', () => {
    /**
     * @target SolanaRosenExtractor.getBlockWithContext projects every
     *   transaction from one raw block response
     * @dependencies
     * - fixture helpers, block context, and extractor; no mocks
     * @scenario
     * - serialize a candidate and ordinary transaction in one block and project
     *   the block
     * @expected
     * - block result preserves indices/signatures and classifies deposit and
     *   non-deposit
     */
    it('getBlockWithContext projects every transaction from one raw block response', async () => {
      const extractor = await makeExtractor();
      const deposit = makeFixture('SOL');
      const ordinary = makeFixture('SOL');
      delete deposit.input.meta.loadedAddresses;
      ordinary.input.transaction.signatures[0] = bs58.encode(
        Buffer.alloc(64, 44),
      );
      ordinary.input.transaction.message.instructions.pop();
      const serialized = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          blockhash: deposit.input.blockhash,
          transactions: [
            {
              version: deposit.input.version,
              transaction: deposit.input.transaction,
              meta: deposit.input.meta,
            },
            {
              version: ordinary.input.version,
              transaction: ordinary.input.transaction,
              meta: ordinary.input.meta,
            },
          ],
        },
      });

      const outcome = extractor.getBlockWithContext(serialized, {
        slot: deposit.input.slot,
        blockhash: deposit.input.blockhash,
      });

      expect(outcome.type).toBe('block');
      if (outcome.type !== 'block') throw new Error('Expected block result');
      expect(outcome.transactions.map(({ outcome }) => outcome.type)).toEqual([
        'deposit',
        'not-deposit',
      ]);
      expect(outcome.transactions[0]).toMatchObject({
        transactionIndex: 0,
        signature: deposit.input.transaction.signatures[0],
        outcome: {
          type: 'deposit',
          context: {
            clusterGenesisHash: deposit.input.clusterGenesisHash,
            sourceTxId: deposit.input.transaction.signatures[0],
            sourceSlot: deposit.input.slot,
            sourceBlockhash: deposit.input.blockhash,
          },
        },
      });
    });

    /**
     * @target SolanaRosenExtractor.getBlockWithContext preserves original
     *   numeric tokens from a block response
     * @dependencies
     * - SOL fixture helper and raw JSON block response; no mocks
     * @scenario
     * - encode the RPC fee as an exponent token and project the raw block
     * @expected
     * - transaction outcome is unavailable with reason INTEGER_ENCODING
     */
    it('getBlockWithContext preserves original numeric tokens from a block response', async () => {
      const extractor = await makeExtractor();
      const fixture = makeFixture('SOL');
      const response = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          blockhash: fixture.input.blockhash,
          transactions: [
            {
              version: fixture.input.version,
              transaction: fixture.input.transaction,
              meta: fixture.input.meta,
            },
          ],
        },
      }).replace('"fee":"5000"', '"fee":5e3');

      const outcome = extractor.getBlockWithContext(response, {
        slot: fixture.input.slot,
        blockhash: fixture.input.blockhash,
      });

      expect(outcome.type).toBe('block');
      if (outcome.type !== 'block') throw new Error('Expected block result');
      expect(outcome.transactions[0].outcome).toEqual({
        type: 'unavailable',
        reason: 'INTEGER_ENCODING',
      });
    });
  });

  describe('getResolvedProfile', () => {
    /**
     * @target SolanaRosenExtractor.getResolvedProfile stays bound to its
     *   original config and TokenMap
     * @dependencies
     * - fixture helpers, TokenMap, and get/getWithContext/getBlockWithContext
     *   consumers; no mocks
     * @scenario
     * - capture profile and projections, mutate source config and token map,
     *   then compare projections
     * @expected
     * - resolved profile identity and all saved projections remain unchanged
     */
    it('getResolvedProfile stays bound to its original config and TokenMap', async () => {
      const config = makeExtractorConfig();
      const externalTokens = await makeTokenMap();
      const extractor = new SolanaRosenExtractor(config, externalTokens);
      const fixture = makeFixture('SOL');
      const serialized = JSON.stringify(fixture.input);
      const expectedGet = extractor.get(serialized);
      const expectedContext = extractor.getWithContext(serialized);
      const block = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          blockhash: fixture.input.blockhash,
          transactions: [
            {
              version: fixture.input.version,
              transaction: fixture.input.transaction,
              meta: fixture.input.meta,
            },
          ],
        },
      });
      const blockContext = {
        slot: fixture.input.slot,
        blockhash: fixture.input.blockhash,
      };
      const expectedBlock = extractor.getBlockWithContext(block, blockContext);
      const descriptor = extractor.getResolvedProfile();

      config.vaultOwner = addresses.sponsor;
      config.destinationNetwork = 'testnet';
      config.assets.SOL.maxAmount = '2';
      const tokenSets = externalTokens.getConfig();
      tokenSets[0][SOLANA_CHAIN].decimals = 8;
      tokenSets[0][ERGO_CHAIN].tokenId = 'ef'.repeat(32);
      await externalTokens.updateConfigByJson(tokenSets);

      expect(extractor.getResolvedProfile()).toBe(descriptor);
      expect(descriptor).toMatchObject({
        genesisHash: addresses.genesis,
        destinationChain: 'ergo',
        destinationNetwork: 'mainnet',
        vaultOwner: addresses.vault,
        memoVersion: 1,
        assets: expect.arrayContaining([
          expect.objectContaining({
            assetId: SOLANA_NATIVE_TOKEN,
            mint: null,
            vaultTokenAccount: null,
            sourceDecimals: 9,
            destinationDecimals: 9,
            destinationTokenId: 'cd'.repeat(32),
          }),
        ]),
      });
      expect(Object.isFrozen(descriptor.assets)).toBe(true);
      expect(extractor.get(serialized)).toEqual(expectedGet);
      expect(extractor.getWithContext(serialized)).toEqual(expectedContext);
      expect(extractor.getBlockWithContext(block, blockContext)).toEqual(
        expectedBlock,
      );
    });
  });
});
