export class UnsupportedAddressError extends Error {
  /** Creates an error describing why a chain address is unsupported. */
  constructor(chain: string, address: string, reason?: string) {
    super(
      `UnsupportedAddressError: Address [${address}] is not supported in current implementation of [${chain}] chain` +
        (reason ? ` (${reason})` : ''),
    );
  }
}
