import bs58 from 'bs58';

import { SOLANA_CHAIN } from '../lib/getRosenData/const';
import { parseRosenData } from '../lib/utils';
import * as testData from './testData';

describe('parseRosenData', () => {
  /**
   * @target `parseRosenData` should extract rosen data successfully
   * @dependencies
   * @scenario
   * - mock utxo with scriptPubKey that contains valid rosen data
   * - run test
   * - check returned value
   * @expected
   * - it should return expected asset transformation
   */
  it('should extract rosen data successfully', () => {
    const script = testData.opReturnScripts.valid;
    const result = parseRosenData(script);

    expect(result).toStrictEqual(testData.opReturnData);
  });

  /**
   * @target `parseRosenData` should throw error
   * when toChain is invalid
   * @dependencies
   * @scenario
   * - mock utxo with scriptPubKey that contain rosen data with invalid toChain
   * - run test & check thrown exception
   * @expected
   * - it should throw error
   */
  it('should throw error when toChain is invalid', () => {
    const script = testData.opReturnScripts.invalidToChain;

    expect(() => {
      parseRosenData(script);
    }).toThrow(Error);
  });

  /**
   * @target parseRosenData maps Solana code 10 without shifting existing codes
   * @dependencies
   * - package parseRosenData export and Solana chain constant; no mocks
   * @scenario
   * - decode a serialized destination with chain code 10
   * @expected
   * - decoded chain is Solana and address matches the encoded key
   */
  it('parseRosenData maps Solana code 10 without shifting existing codes', () => {
    const raw = Buffer.concat([
      Buffer.from([10]),
      Buffer.alloc(16),
      Buffer.from([32]),
      Buffer.alloc(32, 33),
    ]).toString('hex');
    expect(parseRosenData(raw)).toMatchObject({
      toChain: SOLANA_CHAIN,
      toAddress: bs58.encode(Buffer.alloc(32, 33)),
    });
  });
});
