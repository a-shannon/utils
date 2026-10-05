# Solana address codec

This package converts a Solana Base58 public key to and from the 32 raw bytes
used by Rosen address codecs. The encoded form is 64 hexadecimal characters.

Every 32-byte value is accepted as a public key, including off-curve program
derived addresses. This codec does not identify a cluster, account type, mint,
or token program; those belong to higher-level bridge configuration.

The package also validates transaction IDs as canonical Base58 encodings of
64-byte signatures, forms cluster-scoped identities for native SOL and
allowlisted original Token Program mints, and converts integer amounts between
Solana and Ergo units without floating point or dust rounding. Amount conversion
accepts source decimal counts from 0 through 18; unsupported counts fail closed.
