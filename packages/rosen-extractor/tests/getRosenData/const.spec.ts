import { describe, expect, it } from 'vitest';

import {
  AVALANCHE_CHAIN,
  AVALANCHE_NATIVE_TOKEN,
  SUPPORTED_CHAINS,
} from '../../lib/getRosenData/const';

describe('SUPPORTED_CHAINS', () => {
  /**
   * @target SUPPORTED_CHAINS preserves every published destination assignment
   * @dependencies Actual constant registry; no mocks or external requests
   * @scenario Read the ten published chain identities and their byte indices.
   * @expected Preserve indices 0 through 9, including Base at index 9.
   */
  it('preserves every published destination assignment', () => {
    expect(SUPPORTED_CHAINS.filter(({ index }) => index !== undefined)).toEqual(
      [
        { chain: 'ergo', index: 0 },
        { chain: 'cardano', index: 1 },
        { chain: 'bitcoin', index: 2 },
        { chain: 'ethereum', index: 3 },
        { chain: 'binance', index: 4 },
        { chain: 'doge', index: 5 },
        { chain: 'bitcoin-runes', index: 6 },
        { chain: 'firo', index: 7 },
        { chain: 'handshake', index: 8 },
        { chain: 'base', index: 9 },
      ],
    );
  });

  /**
   * @target SUPPORTED_CHAINS registers Avalanche without allocating a byte
   * @dependencies Actual constant registry; no mocks or external requests
   * @scenario Select entries carrying the Avalanche chain name.
   * @expected Find exactly one known identity with an unassigned byte.
   */
  it('registers Avalanche without allocating a byte', () => {
    expect(
      SUPPORTED_CHAINS.filter(({ chain }) => chain === 'avalanche'),
    ).toEqual([{ chain: 'avalanche', index: undefined }]);
  });
});

describe('AVALANCHE_CHAIN', () => {
  /**
   * @target AVALANCHE_CHAIN identifies the native route by its protocol name
   * @dependencies Actual exported constant; no mocks or external requests
   * @scenario Read the chain identity.
   * @expected Match the text identity used by the Ergo return route.
   */
  it('identifies the native route by its protocol name', () => {
    expect(AVALANCHE_CHAIN).toEqual('avalanche');
  });
});

describe('AVALANCHE_NATIVE_TOKEN', () => {
  /**
   * @target AVALANCHE_NATIVE_TOKEN identifies native AVAX
   * @dependencies Actual exported constant; no mocks or external requests
   * @scenario Read the native token identity.
   * @expected Match the native AVAX token identifier.
   */
  it('identifies native AVAX', () => {
    expect(AVALANCHE_NATIVE_TOKEN).toEqual('avax');
  });
});
