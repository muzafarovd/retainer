# Retainer

Retainer is a narrow Tempo prototype for recurring contractor payments. A payer
authorizes one dedicated access key with an explicit token, transfer selector,
single recipient, periodic limit, and expiry. A local runner uses that limited
key and reconciles invoices against observed on-chain results.

> **Current status (2026-10-08):** one owner-signed limited permission,
> two journaled test payments (0.1 and 0.05 pathUSD), a same-block limit test,
> several forbidden-call reverts, and recovery after an injected lost RPC
> response were verified on Moderato. Read-only observations also show a
> replenished limit after a period boundary and zero remaining budget/scopes
> after expiry. **B1 has not passed:** post-boundary signed calls and revocation
> still need evidence. No scheduler is enabled.

## Exact scope

The MVP is deliberately limited to:

- Tempo Moderato testnet;
- one payer/root account and one contractor address;
- pathUSD as the default TIP-20 token;
- `transfer(address,uint256)` as the only allowed selector;
- one recipient, one periodic atomic-unit limit, and one finite expiry;
- a payer-controlled local runner and a local SQLite journal;
- manual execution before any scheduler is enabled.

It does not include fiat or off-ramp flows, token swaps, multiple chains,
marketplace or payroll features, custody of a payer's root key, a hosted runner,
or a claim of exactly-once blockchain execution.

## Network and toolchain

| Item | Pinned value |
| --- | --- |
| Network | Tempo Testnet (Moderato) |
| Chain ID | `42431` |
| RPC | `https://rpc.moderato.tempo.xyz` |
| Explorer | `https://explore.testnet.tempo.xyz` |
| pathUSD | `0x20c0000000000000000000000000000000000000` |
| AccountKeychain | `0xAAAAAAAA00000000000000000000000000000000` |
| Viem | `2.57.2` |
| Node.js | `>=24` |
| pnpm | `11.19.0` |

These are public identifiers, not secrets. The CLI fails closed when a permission
plan uses a chain other than Moderato.

## Security boundary: owner wallet and local test key

The payer's root key stays in the owner's wallet and must never be supplied to the
runner. `access-key-generate` writes one dedicated **test-only** P256 key to an
explicit local file with mode `0600`; the filename and public address are printed,
but key bytes are not. The `secrets/` directory and `*.access-key` files are Git
ignored. Keep the key file on the payer's machine, do not copy it into chat, and
revoke the key in the wallet if the file is exposed. SQLite, plans, and CLI JSON
do not contain the private key. The runner refuses a key file readable by group
or others.

## Install and verify locally

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

Create a local environment file only when needed:

```bash
cp .env.example .env
```

Do not put the root-wallet private key or a seed phrase in `.env`.

## CLI

### 1. Probe Moderato

```bash
pnpm dev -- doctor --json
```

The doctor reads the chain ID, block height, token metadata, and the
AccountKeychain read APIs required for periodic limits and call scopes. A
`b0ReadReady: true` result means only that these read APIs returned their expected
empty-key sentinels; it does not prove protocol enforcement for a real access key.

The compiled equivalent is:

```bash
pnpm build
node dist/cli.js doctor --json
```

### 2. Generate a dedicated test key and create a plan

```bash
pnpm dev -- access-key-generate \
  --payer 0x3333333333333333333333333333333333333333 \
  --out ./secrets/demo.access-key
```

Copy only the `accessKeyAddress` from the output into the next command. The
`--out` file is never overwritten. No root-wallet secret is requested.

```bash
pnpm dev -- permission plan \
  --payer 0x3333333333333333333333333333333333333333 \
  --access-key 0x1111111111111111111111111111111111111111 \
  --access-key-type p256 \
  --recipient 0x2222222222222222222222222222222222222222 \
  --limit-atomic 100000000 \
  --period-seconds 604800 \
  --expires-at 2026-11-01T00:00:00Z \
  --out ./data/permission-review.json
```

Replace all sample values before use and choose the shortest practical expiry.
`100000000` means 100 tokens only after the live metadata confirms 6 decimals.
The output is a deterministic, plan-only JSON object and fingerprint. The payer,
access-key address, and key type are part of that fingerprint. The generated
`tempoAuthorization` object is compile-checked against Viem's authorization
arguments. It also includes a direct owner transaction to AccountKeychain with
the same restrictions. `--out` saves a public, versioned review bundle and refuses to
overwrite an existing file; omit it to print the entire bundle instead. It
does not sign, broadcast, authorize a key, or store a secret. Preserve the
reviewed file and fingerprint with the later authorization transaction.

For the prepared test wallets in this workspace, the review bundle is
`review/plan.json` (ignored by Git). Run `pnpm build` and `pnpm review`, then open
`http://127.0.0.1:8765/` in a browser with Rabby. The server binds only to
127.0.0.1, validates the transaction calldata against the plan, and serves
only the review page and public plan. Check the payer, recipient, pathUSD,
1 pathUSD per 3600 seconds, and expiry before proceeding. The page connects to
Rabby, simulates the owner call, and asks Rabby to show the transaction for your
explicit approval. If the wallet displays unexpected terms, reject it. This
Rabby authorization was subsequently confirmed once; its hash and checks are
recorded in `docs/EVIDENCE.md`. Do not retry an uncertain wallet submission
before checking its history.

### 3. Inspect the on-chain permission

After the owner confirms the exact authorization transaction in a wallet:

```bash
pnpm dev -- permission inspect \
  --payer 0x3333333333333333333333333333333333333333 \
  --access-key 0x1111111111111111111111111111111111111111
```

Inspection is read-only. It reports the observed expiry, limited/unlimited policy,
revocation state, remaining atomic amount, period end, and call scopes. Inspection
anchors every permission read to one block and rejects a non-Moderato RPC.

Compare that snapshot with the exact expected plan:

```bash
pnpm dev -- permission verify \
  --payer 0x3333333333333333333333333333333333333333 \
  --access-key 0x1111111111111111111111111111111111111111 \
  --access-key-type p256 \
  --recipient 0x2222222222222222222222222222222222222222 \
  --limit-atomic 100000000 \
  --period-seconds 604800 \
  --expires-at 2026-11-01T00:00:00Z
```

The command exits nonzero on any readable-field mismatch. Even a matching result
keeps `b1Verified: false`: precompile readback cannot reproduce the originally
signed maximum and period duration, so the signed plan and direct boundary tests
remain mandatory.

### 4. Prepare the local journal

```bash
pnpm dev -- journal init --db ./data/retainer.sqlite
```

`--db` defaults to `./data/retainer.sqlite`. The database uses schema version 2,
file mode `0600`, WAL, and `FULL` synchronous mode. Register a draft that matches
the reviewed plan, then create an invoice:

```bash
pnpm dev -- journal agreement-create \
  --id demo --payer 0x3333333333333333333333333333333333333333 \
  --access-key 0x1111111111111111111111111111111111111111 \
  --recipient 0x2222222222222222222222222222222222222222 \
  --limit-atomic 100000000 --period-seconds 604800 \
  --expires-at 2026-11-01T00:00:00Z
pnpm dev -- journal invoice-create \
  --id invoice-1 --agreement demo --amount-atomic 1000000
```

`agreement-create` always starts in `DRAFT`; a draft cannot pay. After the owner
confirms the exact plan in a compatible Tempo wallet, activate the draft with the
authorization transaction hash and the plan fingerprint:

```bash
pnpm dev -- journal agreement-activate \
  --id demo --authorization-tx 0x... --fingerprint '42431:...'
```

Activation checks the transaction's encoded limit, period, and scope, the successful
`KeyAuthorized` receipt, exact P256 key/payer/expiry, and current one-block
permission readback. It stores the transaction hash,
fingerprint, and readback block in SQLite. It does not sign for the owner and does
not mark the full B1 matrix complete.

Run only the reviewed test invoice, or reconcile an uncertain attempt by its
original hash:

```bash
pnpm dev -- payment run --invoice invoice-1 --key-file ./secrets/demo.access-key
pnpm dev -- payment reconcile --attempt '<attempt-id>'
pnpm dev -- journal invoice-show --id invoice-1
```

`payment reconcile` needs no key file. The runner records signed bytes and hash
before broadcast, checks the permission again, and marks `PAID` only after a
successful receipt whose exact transaction call and TIP-20 `Transfer` event match
the invoice. `invoice-show` retains the latest attempt and hash even after a
terminal result. Two owner-authorized test transfers have confirmed on Moderato;
the second exercised `UNKNOWN` to `PAID` recovery using the original hash.
Several forbidden calls were rejected by the protocol. See
[`docs/EVIDENCE.md`](docs/EVIDENCE.md) for exact results and the remaining
unproven boundaries.

## Amount and status rules

All token amounts are `bigint` values in atomic units. The CLI serializes bigint
values as base-10 strings in JSON. JavaScript floating-point arithmetic is not
used for authorization limits, invoice amounts, or payment comparisons.

`SUBMITTED` is not `PAID`. A payment becomes `PAID` only after a confirmed receipt.
When broadcast may have happened but the outcome cannot be established, the attempt
and invoice remain `UNKNOWN`. `UNKNOWN` blocks a new payment attempt until the
original transaction is reconciled; it never means "safe to retry."

## What the owner must do for B1

The owner must use a test-only payer and dedicated access key, review the exact
plan, sign it in the wallet, and preserve the authorization/transaction evidence.
Then run and record the complete matrix in [`docs/EVIDENCE.md`](docs/EVIDENCE.md):

1. permitted amount to the permitted recipient succeeds;
2. amount above the remaining periodic limit fails outside the UI;
3. another recipient fails;
4. another selector, including `approve`, fails;
5. the wrong token and wrong chain are rejected;
6. expiry and period boundaries behave exactly as documented;
7. concurrent attempts cannot bypass the protocol limit;
8. revocation succeeds and a later access-key payment fails;
9. insufficient balance and RPC failure are reported without a false success;
10. timeout after broadcast is reconciled from the original hash and is never
    automatically paid again.

Until those results and explorer links exist, B1 remains open.

## Project documents

- [`STATE.md`](STATE.md) — current truth, checks, blockers, and next step.
- [`TASKS.md`](TASKS.md) — compact done/doing/next list.
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — behavior and trust decisions.
- [`docs/EVIDENCE.md`](docs/EVIDENCE.md) — reproducible observations and B1 matrix.
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) — assets, boundaries, and residual risk.
- [`docs/SUBMISSION.md`](docs/SUBMISSION.md) — honest English submission draft.

## Primary references

- [Tempo connection details](https://tempo.xyz/developers/docs/quickstart/connection-details)
- [Tempo TypeScript SDK](https://tempo.xyz/developers/docs/sdk/typescript)
- [Tempo T3 network upgrade](https://tempo.xyz/developers/docs/protocol/upgrades/t3)
- [AccountKeychain precompile](https://tempo.xyz/developers/docs/protocol/transactions/AccountKeychain)
- [Viem access-key permission guide](https://viem.sh/tempo/actions/accessKey.signAuthorization)
- [TIP-1011: enhanced access-key permissions](https://tips.sh/1011)

This prototype has not been audited and makes no claim of mainnet readiness,
legal suitability, guaranteed payment, real customers, or production custody.
