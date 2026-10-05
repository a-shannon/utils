import {
  getSolanaAssetIdentityKey,
  SOLANA_NATIVE_ASSET,
  SOLANA_SYSTEM_PROGRAM_ID,
  SOLANA_TOKEN_2022_PROGRAM_ID,
  SOLANA_TOKEN_PROGRAM_ID,
  UnsupportedSolanaAssetError,
} from '../lib';

const clusterGenesisHash = '11111111111111111111111111111111';
const mint = 'So11111111111111111111111111111111111111112';

describe('getSolanaAssetIdentityKey', () => {
  /**
   * @target getSolanaAssetIdentityKey
   * binds native SOL to its cluster and system program
   * @dependencies
   * - cluster genesis hash fixture
   * - SOLANA_SYSTEM_PROGRAM_ID
   * - SOLANA_NATIVE_ASSET
   * - No dependencies or test helpers are mocked
   * @scenario
   * - request the identity key for the native asset on the fixture cluster
   * - compare it with the cluster, system program and native asset key
   * @expected
   * - the returned key contains the fixture cluster, system program and native asset
   */
  it('binds native SOL to its cluster and system program', () => {
    expect(
      getSolanaAssetIdentityKey({ kind: 'native', clusterGenesisHash }),
    ).toEqual(
      `${clusterGenesisHash}:${SOLANA_SYSTEM_PROGRAM_ID}:${SOLANA_NATIVE_ASSET}`,
    );
  });

  /**
   * @target getSolanaAssetIdentityKey
   * binds an SPL mint to its cluster and original Token Program
   * @dependencies
   * - cluster genesis hash fixture
   * - mint fixture
   * - SOLANA_TOKEN_PROGRAM_ID
   * - No dependencies or test helpers are mocked
   * @scenario
   * - request the identity key for the fixture SPL mint and original Token Program
   * - compare it with the cluster, token program and mint key
   * @expected
   * - the returned key contains the fixture cluster, original Token Program and mint
   */
  it('binds an SPL mint to its cluster and original Token Program', () => {
    expect(
      getSolanaAssetIdentityKey({
        kind: 'spl',
        clusterGenesisHash,
        tokenProgramId: SOLANA_TOKEN_PROGRAM_ID,
        mint,
      }),
    ).toEqual(`${clusterGenesisHash}:${SOLANA_TOKEN_PROGRAM_ID}:${mint}`);
  });

  /**
   * @target getSolanaAssetIdentityKey
   * distinguishes a different cluster or mint
   * @dependencies
   * - cluster genesis hash fixtures
   * - mint fixtures
   * - SOLANA_TOKEN_PROGRAM_ID
   * - No dependencies or test helpers are mocked
   * @scenario
   * - create a baseline key for the fixture SPL mint and cluster
   * - create keys changing only the cluster and only the mint
   * - assert each changed key differs from the baseline value
   * @expected
   * - changing the cluster or mint produces a different identity key
   */
  it('distinguishes a different cluster or mint', () => {
    const first = getSolanaAssetIdentityKey({
      kind: 'spl',
      clusterGenesisHash,
      tokenProgramId: SOLANA_TOKEN_PROGRAM_ID,
      mint,
    });
    expect(
      getSolanaAssetIdentityKey({
        kind: 'spl',
        clusterGenesisHash: '11111111111111111111111111111112',
        tokenProgramId: SOLANA_TOKEN_PROGRAM_ID,
        mint,
      }),
    ).not.toEqual(first);
    expect(
      getSolanaAssetIdentityKey({
        kind: 'spl',
        clusterGenesisHash,
        tokenProgramId: SOLANA_TOKEN_PROGRAM_ID,
        mint: '11111111111111111111111111111111',
      }),
    ).not.toEqual(first);
  });

  /**
   * @target getSolanaAssetIdentityKey
   * rejects a noncanonical cluster, mint, and Token-2022 program
   * @dependencies
   * - cluster and mint fixtures
   * - SOLANA_TOKEN_PROGRAM_ID
   * - SOLANA_TOKEN_2022_PROGRAM_ID
   * - UnsupportedSolanaAssetError
   * - No dependencies or test helpers are mocked
   * @scenario
   * - request a native identity with a noncanonical cluster
   * - request SPL identities with a noncanonical mint and with the Token-2022 program
   * - assert each request throws UnsupportedSolanaAssetError
   * @expected
   * - all three unsupported asset inputs are rejected
   */
  it('rejects a noncanonical cluster, mint, and Token-2022 program', () => {
    expect(() =>
      getSolanaAssetIdentityKey({ kind: 'native', clusterGenesisHash: '0' }),
    ).toThrow(UnsupportedSolanaAssetError);
    expect(() =>
      getSolanaAssetIdentityKey({
        kind: 'spl',
        clusterGenesisHash,
        tokenProgramId: SOLANA_TOKEN_PROGRAM_ID,
        mint: '0',
      }),
    ).toThrow(UnsupportedSolanaAssetError);
    expect(() =>
      getSolanaAssetIdentityKey({
        kind: 'spl',
        clusterGenesisHash,
        tokenProgramId: SOLANA_TOKEN_2022_PROGRAM_ID,
        mint,
      }),
    ).toThrow(UnsupportedSolanaAssetError);
  });
});
