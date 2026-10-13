# Evidence ledger

Last updated: 2026-10-06

## Evidence rules

Every entry must distinguish:

- **source fact** — a statement in an official primary source;
- **local verification** — a reproducible command and observed result;
- **testnet observation** — point-in-time data from Moderato;
- **pending** — required evidence that does not exist yet.

Mocks and unit tests are useful, but they are not on-chain B1 proof. Never record a
test transaction as revenue, a test address as a customer, or `b0ReadReady: true` as proof
that all permission restrictions work.

## E-001 — Official network and protocol facts

**Type:** source facts, checked 2026-10-05.

| Fact | Value | Primary source |
| --- | --- | --- |
| Moderato chain ID | `42431` | [Connection details](https://tempo.xyz/developers/docs/quickstart/connection-details) |
| Moderato RPC | `https://rpc.moderato.tempo.xyz` | [Connection details](https://tempo.xyz/developers/docs/quickstart/connection-details) |
| Testnet explorer | `https://explore.testnet.tempo.xyz` | [Connection details](https://tempo.xyz/developers/docs/quickstart/connection-details) |
| TypeScript integration | Viem Tempo extension | [TypeScript SDK](https://tempo.xyz/developers/docs/sdk/typescript) |
| T3 status | Active on testnet and mainnet; includes enhanced access-key permissions | [T3 upgrade](https://tempo.xyz/developers/docs/protocol/upgrades/t3) |
| AccountKeychain address | `0xAAAAAAAA00000000000000000000000000000000` | [AccountKeychain](https://tempo.xyz/developers/docs/protocol/transactions/AccountKeychain) |
| Permission surface | expiry, per-token one-time/periodic limits, target/selector/recipient call scopes | [AccountKeychain](https://tempo.xyz/developers/docs/protocol/transactions/AccountKeychain), [Viem guide](https://viem.sh/tempo/actions/accessKey.signAuthorization) |
| Enhanced-permission specification | TIP-1011 | [TIP-1011](https://tips.sh/1011) |

Project-pinned pathUSD address:
`0x20c0000000000000000000000000000000000000`.

## E-002 — Live B0 doctor observation

**Type:** local verification plus testnet observation.

**Date:** 2026-10-05.
**Command:**

```bash
pnpm build
node dist/cli.js doctor --json
```

**Observed summary:**

- RPC: `https://rpc.moderato.tempo.xyz`;
- chain ID: `42431` (matched expected `42431`);
- block number: `38240397` (point-in-time only);
- token address: `0x20c0000000000000000000000000000000000000`;
- token name/symbol/currency/decimals: `PathUSD` / `pathUSD` / `USD` / `6`;
- AccountKeychain: `0xAAAAAAAA00000000000000000000000000000000`;
- `readApis.periodicLimit.reachable: true`, sentinel valid;
- `readApis.callScope.reachable: true`, sentinel valid;
- `b0ReadReady: true`.

**Interpretation:** the public Moderato RPC, token metadata, and required read APIs
were reachable through the pinned client. This does **not** prove a particular key
was authorized correctly, that a restricted payment succeeds, or that forbidden
calls fail. It is B0 evidence only.

The source-mode public interface is:

```bash
pnpm dev -- doctor --json
```

In the verification sandbox, `tsx` IPC was prohibited, so the compiled path above
was used. That sandbox limitation is not a protocol failure.

## E-003 — Local permission and amount invariants

**Type:** local code/test evidence; verified 2026-10-05.

The current tests cover:

- canonical positive bigint amounts and uint256 upper bound;
- no floating-point formatting path;
- Moderato/pathUSD/transfer/single-recipient/limit/period/expiry binding;
- rejection of another chain, zero recipient, and expired permission;
- `SUBMITTED != PAID` and `UNKNOWN` reconciliation transitions;
- canonical decimal-text storage for bigint atomic values;
- idempotent invoice reservation and independent-connection contention;
- compare-and-set journal transitions, including `UNKNOWN` blocking;
- required and immutable prepared transaction bytes, with a hash recomputed from
  and matched to those exact bytes before the attempt becomes `PREPARED`.
- blocking new reservations for inactive, expired, or undersized agreements;
- preserving authorization evidence before local activation;
- rejecting a signed authorization whose original limit, period, recipient,
  selector, or admin flag differs from the reviewed plan;
- storing a dedicated test P256 key in a `0600` file without printing its bytes;
- runner recovery after an ambiguous broadcast using only the saved hash;
- no replacement attempt after a mismatched receipt hash or a completed invoice.
- file-backed restart recovery without another signature, and simultaneous
  runners retaining one attempt and identical signed bytes;
- a public versioned plan-review file that cannot be silently overwritten;
- visibility of the confirmed attempt/hash after an invoice reaches `PAID`.
- rejection of wrong receipt hash, chain, multi-call transaction, recipient,
  token, amount, and duplicate TIP-20 Transfer events using synthetic ABI logs.

Reproducible command and recorded result:

```bash
pnpm check
pnpm build
# both exit 0; 11 test files passed; 50 tests passed
```

This verifies local invariants only. It is neither B1 on-chain permission proof nor
end-to-end crash-recovery proof.

An exact public review bundle can now be saved with `permission plan --out
./data/permission-review.json`. The local test confirms the file includes the
fingerprint and exact authorization arguments, contains no private-key fields,
and is never overwritten. This is still a proposed plan, not an owner signature.

An offline compiled-CLI `permission plan` smoke run also returned a Viem-compatible
`{ address, type: "p256" }` access-key descriptor, selector `0xa9059cbb`, and the
exact requested payer and recipient. A live read-only `permission inspect` smoke
anchored all fields to one block. `permission verify` was then run against a
deliberately nonexistent key: it returned `onChainReadbackPass: false`,
`b1Verified: false`, and exit code `3`. These checks did not sign, broadcast, or
authorize an access key, so they are not B1 proof.

## E-004 — Journal initialization

**Type:** partial local CLI verification; B2 remains provisional.

```bash
pnpm dev -- journal init --db ./data/retainer.sqlite
```

The compiled equivalent was run against a temporary database:

```bash
node dist/cli.js journal init --db <temporary-directory>/retainer.sqlite
```

It succeeded twice against the same file and reported `initialized: true`, schema
version `1` at that time, `fileMode: "0600"`, `journalMode: "WAL"`, and `synchronous: "FULL"`;
the resulting mode was independently observed as `0600`. The option defaults to
`./data/retainer.sqlite` when omitted. The current schema version is `2` and its
local tests pass; the compiled CLI help exposes activation, invoice, payment, and
reconciliation commands. A targeted repository scan before the dedicated-key
feature found no non-empty root-key or mnemonic assignments.

This local evidence does not prove end-to-end crash recovery or safe payment
execution. The database must continue to contain no private key material.

## E-005 — Manual transfer/recovery implementation

**Type:** local code/test evidence; subsequent live evidence is E-007 and E-009.

The Viem 2.57.2 Tempo adapter derives the configured P256 access-key address from
the local key, checks current on-chain permission and remaining amount before
preparing a `transfer(address,uint256)` call, signs locally, and returns exact
serialized transaction bytes plus `keccak256` hash. The journal persists those
bytes/hash before broadcast. The runner treats ambiguous broadcast and receipt
responses as `UNKNOWN` and reconciles by that saved hash. A successful receipt
must match the transaction's chain, payer, single call, token, recipient, amount,
and exact TIP-20 `Transfer` event before marking an invoice `PAID`.

At the time of this implementation check the network path was provisional;
E-007 and E-009 now record the owner-authorized live payment and recovery test.

## E-006 — Prepared owner authorization, no broadcast

**Type:** local verification plus read-only testnet observation; 2026-10-05.

The payer `0x802C9e90D51ff087A4399A897dC1E5Fd9e853f1d` held 2,000,000
test pathUSD at the time of the RPC read. A separate P256 key was generated
locally with file mode `0600`; only its public address,
`0xa3cE2CE29377eD2e8600d9F2A6E18956dbB26cc0`, is recorded here. The
owner-review bundle uses recipient
`0xf0984b15b8088b4F3C7137998306d1cf0E257553`, pathUSD only, selector
`0xa9059cbb` only, limit `1000000` atomic units (1 pathUSD) per 3600 seconds,
and expiry 2026-10-08 00:00 UTC. Its fingerprint is stored in the ignored local
`review/plan.json` file; the earlier public plan has the same fingerprint.

The exact direct `authorizeKey` owner call to AccountKeychain was simulated with
`eth_call` from the payer on Moderato and returned successfully. The local
review server served the page and matching plan with HTTP 200, and returned 404
for `/secrets/demo.access-key`. The browser-wallet flow itself has not been
exercised; simulation does not prove that Rabby can sign/send it. No transaction
hash, receipt, on-chain permission, or B1 pass exists yet.

An additional read-only `permission inspect` at block `38273249` returned the
empty-key sentinel (`accessKey` zero address, expiry `0`, remaining `0`, no
scopes) for this payer/key pair. The displayed `unlimited`/`secp256k1` defaults
in that empty response do **not** represent an active permission.

The local SQLite journal was initialized as schema version 2 with mode `0600`.
It contains a matching `DRAFT` agreement (`demo-moderato`) and an `OPEN`
test-only invoice (`demo-invoice-1`) for `100000` atomic units, or 0.1 pathUSD.
No payment attempt was started.

## E-007 — Owner authorization and first live payment

**Type:** confirmed Moderato transactions plus local verification; 2026-10-05.

The owner supplied authorization transaction
`0x55ddfe70ec7f480cb832d948665b832d54350423deb54fe9611ff34788b5a959`.
Public RPC returned chain `42431`, payer
`0x802C9e90D51ff087A4399A897dC1E5Fd9e853f1d`, AccountKeychain target,
successful receipt, and block `38275264`. `permission verify` at block
`38275418` found the expected P256 key, pathUSD, finite expiry, limited spend,
only the `transfer` selector, and only the planned recipient. The local
`agreement-activate` command then independently checked the transaction's
encoded 1,000,000-atomic / 3600-second limit and exact scope, successful
`KeyAuthorized` event, and one-block readback. It made `demo-moderato` `ACTIVE`
with `authorizationMode: direct-owner-call`. B1 stayed `false`.

The manual runner sent invoice `demo-invoice-1` for `100000` atomic units
(0.1 test pathUSD) using the dedicated P256 key. Transaction
`0xfa69df0f4a2238f281b4f9d2bebcddc6fe491df66492d09665a03db44b59d724`
was confirmed. The runner verified exact Tempo transaction chain, payer,
single token call, recipient, amount, and one matching TIP-20 `Transfer` event
before setting the attempt to `CONFIRMED` and invoice to `PAID`. A later
permission read at block `38275654` showed `899964` atomic units remaining
in the current period, down from `1000000` before the payment. The observed
difference is `100036` atomic units; `100000` is the transfer, and the
additional `36` is not independently classified here.
The second wallet's public pathUSD balance read after confirmation was
`100000` atomic units (0.1 pathUSD). A pre-payment balance snapshot was not
recorded, so the exact event remains the primary attribution evidence.

This proves one allowed transfer and the journal's live success path. It does
**not** prove forbidden calls fail, period reset, expiry, revocation,
concurrency safety, or recovery after ambiguous broadcast. No second payment
was initiated during this E-007 check; E-009 records a later separate test.

Running `payment run --invoice demo-invoice-1` a second time returned the same
confirmed attempt ID and transaction hash without creating another attempt or
requesting the network. This exercises the already-paid guard, but not crash
recovery or concurrent live runners.

## E-008 — Live forbidden-call checks

**Type:** confirmed Moderato reverts and RPC protocol rejection; 2026-10-06.

The test-only `scripts/probe-negative.mjs` tool prepared each P256-signed Tempo
transaction in a private local file before one send attempt. Each file records
the exact call and hash; a separate send-intent marker prevents the tool from
submitting the same file twice. It does not read or export the root-wallet key.

| Probe | Bounded call | Original hash | Outcome |
| --- | --- | --- | --- |
| Wrong selector | `balanceOf(payer)` on pathUSD, no transfer | `0x40ca514d554896a09f474604f73936c7f6f9db877b723f0e21ea0a7ee01fb23c` | Confirmed reverted, block `38396172` |
| Wrong recipient | 1 atomic pathUSD to payer itself | `0x04e9268cf3dbbc63ad77566828989104d08ec744e1504b9d6dc15c795fc4c1f1` | Confirmed reverted, block `38396264` |
| Over limit | 1,000,001 atomic pathUSD to allowed recipient | `0x3b81e0cfcaab219279a7ac8ccd17eaadc5ea856db8f8d38adf48c8721a5d52f9` | Confirmed reverted, block `38396336` |
| Wrong token | 1 atomic alphaUSD transfer to allowed recipient | `0xfdc9ac12fecbf48788a2e3bc2362a0f21a84935feeede2666386c43e6eeb4ced` | RPC rejected with `SpendingLimitExceeded`; no receipt on follow-up lookup |
| Forbidden `approve` | Approve allowed recipient for 0 pathUSD | `0xc63fa703c3ce43c6c6c1e6be92feacf8288e5b9c00532e213aa24e446404e149` | Confirmed reverted, block `38396797` |

Before the wrong-token call, `alphaUSD` metadata was read at
`0x20C0000000000000000000000000000000000001` (6 decimals), and the payer had
`2000000000000` atomic alphaUSD. Thus its rejection was not caused by a
nonexistent token or insufficient alphaUSD balance. The wrong-token RPC did
not accept a hash and a later receipt lookup remained empty; it was not retried.
The compiled `permission plan --chain-id 4217` command exited 1 with
`chainId must be Moderato (42431); received 4217.` This is a local wrong-chain
guard, not an on-chain replay-protection test.
The wrong-selector call reduced remaining pathUSD budget from the fresh period
maximum by 23 atomic units. Decoding all four reverted receipts found only
pathUSD fee `Transfer` events from the payer to `0xfeEC...` for 23, 26, 26,
and 23 atomic units respectively; none transferred tokens to the planned
recipient. A fee can consume allowance even when a transaction reverts.

These observations support the limit, recipient, selector, and token
restrictions on this key. They do not yet prove period reset, expiry,
concurrent-limit behavior, or post-revocation rejection.

## E-009 — Live ambiguous-broadcast recovery

**Type:** real Moderato transfer with deliberately lost application response;
2026-10-06.

Invoice `demo-recovery-1` was created for `50000` atomic pathUSD (0.05 test
pathUSD) to the same allowed recipient. `scripts/probe-recovery.mjs` used the
normal runner and transfer port but deliberately threw an error after the RPC
accepted the original signed transaction. The journal retained one attempt
`demo-recovery-1:865073bb-5aa3-4e54-86ae-34b50e3d6b3a` in `UNKNOWN` with
the pre-recorded hash
`0x70151e817217be25e04082322b6de90af39e267bf538896cbd30334856e22d40`.
The RPC-accepted hash matched the prepared hash.

A separate compiled CLI process ran `payment reconcile` using that attempt ID,
without a key file. It found and verified the original receipt and TIP-20
transfer, then marked the same attempt `CONFIRMED` and invoice `PAID`. A later
`payment run` returned the same attempt ID/hash without a second transaction.
This is a live success path for response-loss recovery, but the failure was
injected after RPC acceptance, not an organic RPC outage. Live two-runner
concurrency and recovery across a process crash before response handling remain
to be tested.

## E-010 — Concurrent limit check in one block

**Type:** two confirmed Moderato receipts plus readback; 2026-10-06.

Before the test, the current-period pathUSD permission had `949869` atomic
units remaining and period end `1791277105`. The test-only
`scripts/probe-concurrency.mjs` prepared two 0.6 pathUSD transactions to the
allowed recipient with successive nonces `7` and `8`. Both signed bytes and
hashes were stored privately before a single near-simultaneous submission;
the send-intent marker prevents a second submission from this tool.

Both hashes were accepted by RPC. In block `38397290`, transaction
`0x5013569668ada0b16ab0d950713ddad23f0bfb23be36c6e18bb40b4c2f183af3`
**succeeded** and transaction
`0xd541a9214ee986b7711195ba497d125fe715b52c92596038259415c4a1f22015`
**reverted**. Later readback at block `38397339` showed `349810` atomic units
remaining in the same period. The allowed recipient's pathUSD balance was
`750000` atomic units (0.75 pathUSD), matching the earlier 0.1 + 0.05 and
one 0.6 payment; the second 0.6 did not arrive. The remaining-budget decrease
includes the successful transfer and test transaction fees.

This is direct same-block evidence that these two attempts did not jointly
exceed the periodic limit. It does not establish the behavior for arbitrary
numbers of concurrent senders or all mempool ordering cases.

## E-011 — Read-only period-reset observation

**Type:** Moderato permission reads on either side of the period boundary;
2026-10-06. No transaction was signed or submitted for this check.

For payer `0x802C9e90D51ff087A4399A897dC1E5Fd9e853f1d` and access key
`0xa3cE2CE29377eD2e8600d9F2A6E18956dbB26cc0`, the last recorded
pre-boundary read at block `38397339` (block timestamp `1791274739`,
2026-10-06 08:18:59 UTC) showed `remaining=349810` atomic pathUSD and
`periodEnd=1791277105` (2026-10-06 08:58:25 UTC).

The read-only `permission inspect` at block `38403484` (block hash
`0x2f84c9721a3b46781ad0866b48123529ef29ae964b9ee892671be18e818efae4`,
block timestamp `1791278556`, 2026-10-06 09:22:36 UTC) returned
`remaining=1000000` atomic pathUSD and `periodEnd=1791280705`
(2026-10-06 09:58:25 UTC). It also returned `chainId=42431`, token
`0x20C0000000000000000000000000000000000000`, `keyType=p256`,
`expiry=1791417600`, `spendPolicy=limited`, `isRevoked=false`, and the
same transfer-only selector `0xa9059cbb` with sole recipient
`0xf0984b15b8088b4F3C7137998306d1cf0E257553`.

The readback demonstrates that the allowance appeared replenished after the
boundary, and the reported period end advanced by exactly 3600 seconds. The
two snapshots do not determine the precise reset instant or prove a new
post-reset spend would succeed; no payment was made to test that.

## E-012 — Read-only observation after key expiry

**Type:** Moderato permission read; 2026-10-08. No transaction was signed or
submitted, and the key was not revoked during this check.

For payer `0x802C9e90D51ff087A4399A897dC1E5Fd9e853f1d` and access key
`0xa3cE2CE29377eD2e8600d9F2A6E18956dbB26cc0`, `permission inspect`
returned at block `38663474` (hash
`0x6427ccced00cc0b8ec740fbbdccd28e8f56c813d63e7a2ffa888360d9cf57f48`,
block timestamp `1791435890`, 2026-10-08 05:04:50 UTC):
`chainId=42431`, `token=0x20C0000000000000000000000000000000000000`,
`keyType=p256`, `expiry=1791417600` (2026-10-08 00:00:00 UTC),
`spendPolicy=limited`, `isRevoked=false`, `remaining=0`, `periodEnd=0`,
`isScoped=true`, and `scopes=[]`. The block timestamp is 18290 seconds after
the stored expiry.

This readback shows no remaining budget or returned call scopes after expiry.
It does not establish that a new key-signed call is rejected, because no such
call was made. `isRevoked=false` distinguishes expiry from explicit revocation;
this observation does not satisfy the B1 revocation test.

## B1 owner-run test matrix

**Overall status: PARTIAL / NOT PASSED.**

Use one test-only payer, one dedicated access key, one contractor recipient, and
test funds. Preserve the signed plan/fingerprint, authorization transaction, exact
commands or calldata, receipts/reverts, timestamps, and explorer links.

| ID | Test | Expected result | Required evidence | Status |
| --- | --- | --- | --- | --- |
| B1-01 | Inspect authorized key | Exact payer/key, finite expiry, limited spend, scoped calls | plan fingerprint + authorization tx + inspect JSON | Passed (E-007) |
| B1-02 | Transfer within remaining limit to allowed recipient | Confirmed | tx hash, receipt, before/after remaining limit | Passed (E-007) |
| B1-03 | Transfer above remaining limit | Protocol rejection; no recipient payment | raw revert/error and no recipient Transfer (fee may consume budget) | Passed: reverted with fee-only Transfer event (E-008) |
| B1-04 | Transfer to another recipient | Protocol rejection | raw revert/error | Passed (E-008) |
| B1-05 | Call another selector, including `approve` | Protocol rejection | raw revert/error | Passed (E-008) |
| B1-06 | Use another token or chain | Rejected before or by protocol as specified | command/calldata and error | Token protocol rejection and wrong-chain local guard passed (E-008) |
| B1-07 | Cross periodic reset boundary | Reset exactly when documented; no early/extra budget | timestamps, blocks, limit reads | Partial: post-boundary readback replenished to 1000000; exact reset instant and post-reset spend untested (E-011) |
| B1-08 | Reach expiry boundary | New key-signed call rejected at/after expiry | timestamps, block, raw error | Partial: post-expiry readback shows zero remaining budget and no returned scopes; signed-call rejection untested (E-012) |
| B1-09 | Two concurrent spends near the limit | Combined spend cannot exceed protocol limit | both hashes/results and limit reads | Passed for one same-block pair (E-010) |
| B1-10 | Revoke, then try again | Revocation confirmed; later call rejected | revoke tx + failed call | Pending |
| B1-11 | Insufficient balance | Honest failure, no `PAID` | receipt/error and journal state | Pending |
| B1-12 | RPC timeout after possible broadcast | `UNKNOWN`; reconcile original hash; no automatic replacement | attempt record + recovery trace | Passed with injected response loss (E-009) |

### Acceptance rule

B1 passes only when B1-01 through B1-10 have reproducible evidence and no observed
behavior contradicts the claimed recipient, selector, token, limit, period, expiry,
or revocation boundary. B1-11 and B1-12 must also pass before the runner is presented
as safe for the complete demo.

## External validation

**Status:** pending.

No external payer/contractor pair, paid pilot, revenue, or repeat usage is recorded
here. Add only consented, factual, minimally identifying observations.
