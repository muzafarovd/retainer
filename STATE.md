# Retainer project state

Last updated: 2026-10-08

## Current milestone

**B0 baseline + live owner authorization, test payments, negative calls,
same-block limit concurrency, injected-response-loss recovery, and read-only
period/expiry observations. B1 is not passed.**

The repository currently provides a strict TypeScript domain model, a read-only
Moderato doctor, a permission planner, on-chain permission inspection, atomic-unit
amount handling, a locally tested SQLite journal, a limited-key Tempo transfer
adapter, and manual payment/reconciliation commands. The journal initialization
interface is `pnpm dev -- journal init --db ./data/retainer.sqlite`.

## What is verified

- Toolchain contract: Node.js `>=24`, pnpm `11.19.0`, Viem `2.57.2`.
- Moderato public facts are pinned: chain ID `42431`, RPC
  `https://rpc.moderato.tempo.xyz`, explorer
  `https://explore.testnet.tempo.xyz`.
- A live compiled CLI doctor run returned `b0ReadReady: true` at block `38240397`:
  chain ID `42431`; PathUSD / `pathUSD`, currency `USD`, 6 decimals; AccountKeychain
  periodic-limit and call-scope read APIs reachable with valid sentinels.
- Permission plans bind chain, token, `transfer(address,uint256)`, exactly one
  recipient, atomic limit, fixed period, and finite expiry. An offline compiled-CLI
  smoke returned selector `0xa9059cbb` with the exact requested recipient.
- Amount parsing and formatting use bigint/atomic units and reject zero, decimal,
  non-canonical, and greater-than-uint256 inputs.
- Payment-state rules do not equate RPC submission with payment confirmation and
  preserve `UNKNOWN` for reconciliation.
- `pnpm check` passes locally: 12 test files and 55 tests, including SQLite atomic
  reservation, cross-connection contention, compare-and-set transitions, and
  immutable prepared transaction/hash coverage, duplicate-run recovery, and a
  private test-key file. File-backed restart and two-runner tests retain one
  attempt and reconcile the original hash without signing again.
- `permission plan --out` writes a public versioned review bundle with an exact
  fingerprint and refuses to overwrite it; `invoice-show` includes terminal
  payment attempts for later evidence review.
- Pure Tempo receipt verification is tested with synthetic ABI logs: wrong hash,
  chain, call count, recipient, token, amount, and duplicate transfer events fail
  closed. These are local tests, not a live Moderato transfer.
- Permission inspection rejects another chain and anchors metadata, limit, and
  scope reads to one block; `permission verify` fails closed on a deliberately
  nonexistent key while keeping B1 false.
- `pnpm build` succeeds. The compiled CLI exposes key generation, draft and invoice
  creation, evidence-backed activation, manual payment, and keyless reconciliation.
- Journal schema version `2` stores authorization evidence separately from the
  dedicated private key; the database file mode remains `0600`. Activation also
  compares the signed authorization's original limit, period, and scopes, or
  an exact direct owner call to AccountKeychain.
- The test payer held 2,000,000 test pathUSD at a point-in-time Moderato read.
  A local review page and plan for one P256 access key were prepared: only
  pathUSD transfers to one recipient, at most 1 pathUSD per hour, expiring
  2026-10-08 00:00 UTC. The direct owner call passed `eth_call` simulation
  from the payer address and was subsequently signed and confirmed.
- The review server binds only to 127.0.0.1, verifies plan/calldata agreement,
  and returns 404 for the secret-key path. This is a local smoke check, not a
  browser-wallet end-to-end test.
- The local journal has a `DRAFT` agreement `demo-moderato` matching the review
  fingerprint and an `OPEN` test invoice `demo-invoice-1` for 0.1 pathUSD at
  creation time. Both are now active/paid after live evidence checks.
- The owner authorization transaction `0x55ddfe70ec7f480cb832d948665b832d54350423deb54fe9611ff34788b5a959`
  succeeded on Moderato. The local activation verifier matched its exact
  direct owner call, event, and one-block permission readback.
- The first test invoice paid 0.1 pathUSD to the planned recipient via the
  dedicated P256 key. Transaction
  `0xfa69df0f4a2238f281b4f9d2bebcddc6fe491df66492d09665a03db44b59d724`
  was confirmed and exact transaction/Transfer event verification passed.
  Local invoice status is `PAID`, attempt status `CONFIRMED`.
- Signed-key probes for over-limit, wrong-recipient, forbidden `balanceOf` and
  zero-amount `approve` calls were confirmed reverted. A wrong-token alphaUSD
  transfer was rejected by RPC with `SpendingLimitExceeded`; it was not retried.
- A 0.05 pathUSD test payment reached `UNKNOWN` after a deliberately lost
  application response despite RPC acceptance. A separate process reconciled
  the original hash without a key file and marked the same attempt `PAID`.
- Two 0.6 pathUSD signed-key transfers were submitted near-simultaneously;
  both were included in one block, one succeeded and one reverted. Recipient
  balance readback matched exactly one of the pair.
- A later read-only permission snapshot showed the periodic allowance
  replenished after the boundary. It did not prove the exact reset instant or
  a successful post-reset spend.
- After expiry, read-only inspection showed zero remaining budget and no
  returned call scopes, while `isRevoked=false`. No post-expiry signed call or
  revocation test was performed.

The live doctor result is recorded in [`docs/EVIDENCE.md`](docs/EVIDENCE.md). It is
B0 evidence, not proof that a real permission or payment is correct.

## Not yet verified

- Exact period reset timing, post-reset spend, post-expiry signed-call rejection,
  revocation, and insufficient-balance boundaries still lack live evidence.
- Recipient, selector, token, limit, period, expiry, concurrency, and revocation
  enforcement have not completed the B1 matrix.
- Organic RPC outage and process-crash recovery, as distinct from injected
  response loss, have not yet been exercised against the testnet.
- There is no scheduler, hosted payer UI, external payer/contractor validation, mainnet
  deployment, audit, or production claim.

## Trust boundary

The payer's root key stays in the owner's wallet. Planning and inspection are
read-only. The dedicated test-only P256 key is generated into a local `0600` file
chosen by the payer; it is ignored by Git and is never printed or written to
SQLite. SQLite stores authorization and payment records, not signing secrets.

## Known blockers and risks

1. B1 still requires protocol-level negative-call and boundary evidence;
   a successful authorization and payment do not prove forbidden calls fail.
2. On-chain readback cannot by itself prove the originally configured maximum and
   duration, so the signed plan plus boundary tests must be preserved.
3. A public RPC can time out or return stale/incomplete observations; ambiguous
   post-broadcast outcomes must remain `UNKNOWN`.
4. B2 has a live injected-response-loss reconciliation, but not an organic RPC
   outage/process-crash test; no scheduler is enabled.
5. External demand is unverified; a real payer/contractor pair is still needed.

## Next concrete step

Complete the remaining B1 boundary/revocation and B2 outage/crash cases from
[`docs/EVIDENCE.md`](docs/EVIDENCE.md). Do not start scheduled payments before
both are evidenced.
