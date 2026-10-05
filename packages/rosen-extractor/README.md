# @rosen-bridge/rosen-extractor

<p align="center">
  <a href="https://www.npmjs.com/package/@rosen-bridge/rosen-extractor"><img src="https://img.shields.io/npm/v/@rosen-bridge/rosen-extractor"></a>
  <img src="https://img.shields.io/npm/l/@rosen-bridge/rosen-extractor"></a>
<p>

## Table of contents

- [Description](#description)
- [Installation](#installation)
- [Usage](#usage)

## Description

`@rosen-bridge/rosen-extractor` is a core Rosen Bridge module responsible for extracting and validating bridge request data from blockchain transactions. It converts chain-specific transaction data into a standardized bridge request format consumed by Rosen Watcher and Guard services as part of the bridge verification and execution pipeline.

The extractor module is responsible for identifying and parsing bridge requests embedded in transactions across supported blockchains. It achieves this through a set of chain-specific extractors (such as `ErgoNodeRosenExtractor`, `CardanoKoiosExtractor`, and others), each of which understands the transaction structure and data formats of its respective chain and provider.

In addition to raw data extraction, the module performs several validation and normalization steps required by the bridge protocol (note that these steps are taken in the `AbstractRosenExtractor` class):

- Destination addresses are validated against the target chain using `@rosen-bridge/address-codec` package.
- Tokens are resolved through `TokenMap` to ensure the requested asset is supported on both the source and target chains.
- Transfer amounts are normalized to account for differing decimal precisions across blockchains using `TokenMap.wrapAmount`.

The output of the extractor is a normalized bridge request object containing the target chain and address, source transaction information, token identifiers on both chains, transfer amount, and the bridge and network fees specified in the transaction. This object represents the canonical input used by Rosen Watchers for observation and by Guards for verification and signing.

The fees extracted by this package represent the values explicitly declared by the user in the transaction. They do not reflect the effective fees enforced by the protocol. If the specified fees are below the configured minimum fee—defined on-chain on Ergo—the Rosen Guards will apply the minimum fee instead. For more information on fee configuration and enforcement, see the [`@rosen-bridge/minimum-fee`](https://www.npmjs.com/package/@rosen-bridge/minimum-fee) package.

The extracted bridge request data includes the following fields:

- **`toChain`**: Target blockchain
- **`toAddress`**: Destination address on the target blockchain
- **`bridgeFee`**: Bridge fee specified in the transaction
- **`networkFee`**: Network fee specified in the transaction
- **`fromAddress`**: Source address transferring assets to the lock address
- **`sourceChainTokenId`**: Token identifier on the source blockchain
- **`amount`**: Transfer amount
- **`targetChainTokenId`**: Token identifier on the target blockchain
- **`sourceTxId`**: Source transaction identifier
- **`rawData`**: Raw transaction data from which the request was extracted

> Note: The `rawData` field is a small subset of the original transaction data while omitting the irrelevant data. It is included for reference and debugging purposes. For example, on Bitcoin, the `rawData` is the scriptPubKey of OP_RETURN output that contains Rosen data while on Bitcoin-Runes, it is the entire transaction outputs.

There are two functions that can be used to extract the bridge request data:

1. `extractData`: This function takes a transaction data as input and returns the extracted bridge request data. It is implemented in the child classes based on the chain and provider.
2. `get`: This function wraps the `extractData` function and adds additional validation and normalization steps (i.e., validate the destination address and normalize the amount). It is recommended to use this function instead of `extractData` as it provides a more consistent and reliable output. It is implemented in the `AbstractRosenExtractor` class.

## Installation

```sh
npm i @rosen-bridge/rosen-extractor
```

## Usage

This package requires the `@rosen-bridge/address-manager` package for the decoding and validation of addresses in the bridge request. Please make sure to initialize the `AddressManager` before using any of the extractor classes. You can define the validator and decoder functions based on your needs. Alternatively, you can initialize it with the implementations of `address-codec` package:

```ts
import { ConsoleLogger } from '@rosen-bridge/abstract-logger';
import { chainValidators, chainDecoders } from '@rosen-bridge/address-codec';
import { AddressManager } from '@rosen-bridge/address-manager';

AddressManager.init(chainValidators, chainDecoders, new ConsoleLogger());
```

To use the class, The transaction data must be provided in the format expected by the specific extractor class being used. Here's a basic example of how to use this package:

```typescript
import { ErgoNodeRosenExtractor } from '@rosen-bridge/rosen-extractor';
import { TokenMap } from '@rosen-bridge/tokens';
import ergoNodeClientFactory from '@rosen-clients/ergo-node';

// generate the Ergo node client
const ergoNodeUrl = '';
const nodeClient = ergoNodeClientFactory(ergoNodeUrl);

// get the transaction from Ergo node
const lockTxId =
  '9115d6d6f22269949de1118f1415e7ef8aa717b232f3c6a3710178475a87af05'; // a sample lock transaction
const tx = await nodeClient.getTxById(lockTxId);

// generate the TokenMap
const tokenMapJson = {}; // you can get the token map json from GitHub releases (https://github.com/rosen-bridge/contract/releases)
const tokenMap = new TokenMap();
await tokenMap.updateConfigByJson(tokenMapJson);

// generate the Rosen Extractor for Ergo Node provider
const ergoLockAddress =
  'nB3L2PD3J4rMmyGk7nnNdESpPXxhPRQ4t1chF8LTXtceMQjKCEgL2pFjPY6cehGjyEFZyHEomBTFXZyqfonvxDozrTtK5JzatD8SdmcPeJNWPvdRb5UxEMXE4WQtpAFzt2veT8Z6bmoWN'; // the Rosen lock address on Ergo the time of the sample
const rosenExtractor = new ErgoNodeRosenExtractor(ergoLockAddress, tokenMap);

// extract and display the Rosen data
const res = rosenExtractor.get(tx);
console.log(res);
```

### Solana deposit profile

`SolanaRosenExtractor.get(serializedTransaction)` supports native SOL and
explicitly configured mints of the original SPL Token Program, with Ergo as the
destination. Initialize `AddressManager` as above and supply a
`SolanaRosenExtractorConfig` and `TokenMap`. The extractor validates the Ergo
address with `ergo-lib-wasm-nodejs` for the configured mainnet or testnet and
checks the canonical Base58 round trip. Its inherited `get()` method therefore
uses the same destination-network rule as contextual extraction. The read-only+`getResolvedProfile()` descriptor exposes the policy actually applied by the+projector for a scanner to bind into its persistent profile.

The input is a JSON transaction projection enriched by a source connector:

- `transaction` contains signatures and the compiled message; `version` is
  `"legacy"` or `0`. v0 requires resolved loaded addresses and lookup metadata.
- `meta` contains execution status, internal-instruction traces, balances and
  token-balance metadata. At the top level, the connector adds `clusterGenesisHash`, `slot`,
  `blockhash`, `commitment: "finalized"` and `destinationNetwork`.
- SPL additionally requires transaction-specific `history` snapshots of the
  mint, source token account and configured vault token account, before and
  after execution, bound to the same slot, first signature and cluster.

Preserve exact monetary values as canonical decimal strings or unsigned JSON
integer tokens. Do not parse RPC balances through JavaScript `Number` and then
serialize them: precision already lost upstream cannot be recovered. Decimal
or exponent notation is rejected in consumed integer fields; fractional
`uiAmount` display fields are ignored. Duplicate JSON keys are rejected. Numeric
token recovery uses the native JSON reviver source context available in the
required Node runtime.

Each eligible transaction contains one external System Transfer or SPL
TransferChecked, followed by one canonical Memo signed by the payment authority.
The profile rejects CPI, multiple payments, extra instructions, Token-2022 and
wSOL. Configured `minAmount`, `maxAmount`, `networkFee` and `bridgeFee` use source
units. Configured fees must equal the Memo fees. Amount and fees
must convert exactly to the shared TokenMap scale, with no rounding or dust.

This extractor checks the consistency of the supplied projection. It does not
verify transaction signatures cryptographically, establish finality, resolve
historical lookup tables, or authenticate historical account snapshots. The
connector and independent source verifier must establish those properties.
Current account reads cannot replace transaction-specific history. The returned
`RosenData` keeps the first signature as `sourceTxId`, but does not carry the
cluster, block, slot or historical evidence: retain that context separately for
observation persistence and source verification. `rawData` contains only the
base58 Memo instruction data unless raw-data storage is disabled. Use `get()`
for the normalized amount; the lower-level `extractData()` retains source units
in `amount` while already returning normalized fees.
