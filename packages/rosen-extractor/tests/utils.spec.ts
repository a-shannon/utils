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
   * @target parseRosenData refuses an unassigned Avalanche destination byte
   * @dependencies Actual parser and registered address codecs; no external calls
   * @scenario Replace only the valid fixture's chain byte with unassigned 10.
   * @expected Reject before address decoding; neither Base nor Avalanche aliases 10.
   */
  it('refuses an unassigned Avalanche destination byte', () => {
    const script = '0a' + testData.opReturnScripts.valid.slice(2);
    expect(() => parseRosenData(script)).toThrow(/invalid toChain code/);
  });
});
