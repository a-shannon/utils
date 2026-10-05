import {
  SOLANA_NATIVE_ASSET,
  SOLANA_SYSTEM_PROGRAM_ID,
  SOLANA_TOKEN_PROGRAM_ID,
} from './const';
import { validateSolanaAddress } from './solana';

export type SolanaAssetIdentity =
  | { kind: 'native'; clusterGenesisHash: string }
  | {
      kind: 'spl';
      clusterGenesisHash: string;
      tokenProgramId: string;
      mint: string;
    };

export class UnsupportedSolanaAssetError extends Error {
  /** Creates an error with the policy check that rejected the asset. */
  constructor(code: 'CLUSTER' | 'TOKEN_PROGRAM' | 'MINT' | 'ASSET_KIND') {
    super(`UnsupportedSolanaAssetError: ${code}`);
    this.name = 'UnsupportedSolanaAssetError';
  }
}

/** Returns a canonical policy key bound to a cluster, program, and asset. */
export const getSolanaAssetIdentityKey = (
  asset: SolanaAssetIdentity,
): string => {
  try {
    validateSolanaAddress(asset.clusterGenesisHash);
  } catch {
    throw new UnsupportedSolanaAssetError('CLUSTER');
  }

  if (asset.kind === 'native')
    return `${asset.clusterGenesisHash}:${SOLANA_SYSTEM_PROGRAM_ID}:${SOLANA_NATIVE_ASSET}`;

  if (asset.kind !== 'spl') throw new UnsupportedSolanaAssetError('ASSET_KIND');
  if (asset.tokenProgramId !== SOLANA_TOKEN_PROGRAM_ID)
    throw new UnsupportedSolanaAssetError('TOKEN_PROGRAM');

  try {
    validateSolanaAddress(asset.tokenProgramId);
    validateSolanaAddress(asset.mint);
  } catch {
    throw new UnsupportedSolanaAssetError('MINT');
  }

  return `${asset.clusterGenesisHash}:${asset.tokenProgramId}:${asset.mint}`;
};
