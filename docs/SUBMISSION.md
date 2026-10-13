# Retainer — submission draft

Last updated: 2026-10-08

> Draft only. Replace every bracketed item and attach evidence before submission.
> Do not describe B1, a pilot, users, revenue, or an audit as complete unless the
> corresponding evidence exists.

## One-line description

Retainer lets a payer authorize recurring contractor payments on Tempo with an
explicit recipient, token, transfer selector, periodic spending limit, expiry, and
revocation path, while linking invoices to observed payment outcomes.

## Problem

Recurring contractor payments create repetitive signing work, but handing a runner
an unrestricted wallet key creates unacceptable authority. UI-only limits do not
protect the payer when a script, server, or key is compromised. Payment systems also
need to handle the hard case where a transaction may have been broadcast but its
result is temporarily unknown.

## Solution

Retainer uses Tempo's native AccountKeychain permissions to authorize a dedicated
access key for one narrow task. The planned permission is bound to Moderato, pathUSD,
`transfer(address,uint256)`, one contractor recipient, a bigint periodic limit, and
a finite expiry. The payer retains the root key and can revoke the access key.

A local runner and SQLite journal reserve each invoice once, persist transaction
attempts, and treat ambiguous post-broadcast results as
`UNKNOWN` until the original transaction is reconciled. RPC submission alone never
marks an invoice paid.

## Why Tempo

Tempo T3 provides periodic token spending limits and target/selector/recipient call
scopes at the protocol level. That makes the authorization boundary independently
testable outside Retainer's UI. The project uses the Tempo extension in Viem rather
than introducing a custom contract before it is necessary.

## Current implementation

- TypeScript CLI and strict domain layer;
- Moderato doctor for chain, token metadata, and required AccountKeychain APIs;
- deterministic permission planning without signing or broadcasting;
- an overwrite-safe public review bundle for the exact permission fingerprint;
- read-only on-chain permission inspection;
- bigint/atomic-unit money handling;
- payment-attempt states that distinguish `SUBMITTED`, `UNKNOWN`, and `CONFIRMED`;
- a local SQLite journal with tested reservation, contention, state-transition,
  prepared-transaction, and ambiguous-broadcast invariants;
- a manual Viem Tempo transfer path, evidence-backed local activation, and
  keyless reconciliation by the original transaction hash;
- offline receipt-validation and file-backed restart/two-runner tests.

The project pins Viem `2.57.2`, Node.js `>=24`, and pnpm `11.19.0`.

## Honest status

The live B0 doctor has observed Moderato chain ID `42431`, pathUSD metadata (6
decimals), and support for the periodic-limit and call-scope read APIs. This is not
B1 proof.

**B1 is not passed.** The evidence bundle now records one owner-signed restricted
key, permitted transfers, forbidden recipient/selector/over-limit calls, one
same-block limit test, and read-only observations after a period boundary and
after expiry. Exact reset timing, a post-reset spend, a post-expiry signed-call
rejection, revocation, and insufficient-balance behavior remain untested.
The B2 journal/recovery path passed local invariant tests and one live
injected-response-loss reconciliation without a replacement payment; organic
RPC outage and process-crash cases remain untested. The current schema is 2.

There is no mainnet deployment, external audit, confirmed external payer/contractor
pilot, paid usage, or revenue claim.

## Demo plan

1. Run `pnpm dev -- doctor --json` and show Moderato/token/capability checks.
2. Generate a plan for one contractor and explain every permission field.
3. Show the previously confirmed owner authorization and its exact scope.
4. Run read-only `permission inspect` and compare the observed scope with the
   signed plan, noting that the original demo key has expired.
5. Show the previously confirmed allowed payments and their explorer receipts.
6. Show recorded protocol rejections for over-limit and another-recipient calls,
   clearly labeling these as prior testnet transactions.
7. Show the local journal's recorded `UNKNOWN` to `PAID` reconciliation using
   the original hash and no replacement payment.

These are records of the past testnet run, not a claim of a new live transfer.
Do not present revocation or post-expiry signed-call rejection as completed.

## Trust and limitations

- The root-wallet private key never enters the application. The dedicated test
  access key is kept in a local `0600` file outside the journal and ignored by Git.
- The first runner is local and payer-controlled.
- Protocol limits bound authority; they do not guarantee sufficient balance,
  contractor performance, invoice approval, or network uptime.
- Fixed seconds are not described as a calendar month.
- `UNKNOWN` is not success and is never permission to pay again automatically.
- Testnet funds and transactions are not customers, revenue, or legal validation.

## Technical facts

| Item | Value |
| --- | --- |
| Track | Tempo |
| Network | Moderato testnet |
| Chain ID | `42431` |
| RPC | `https://rpc.moderato.tempo.xyz` |
| Explorer | `https://explore.testnet.tempo.xyz` |
| Default token | pathUSD `0x20c0000000000000000000000000000000000000` |
| AccountKeychain | `0xAAAAAAAA00000000000000000000000000000000` |
| Language/tooling | TypeScript, Viem `2.57.2`, Node.js `>=24`, pnpm `11.19.0` |

## Validation and user plan

Before submission, recruit one real payer/contractor pair for a test-funds flow.
Record the payer's actual requirements for limit, period, expiry, and revocation,
plus whether they would repeat the flow. Do not publish personal details without
consent. One willing contractor without payer authorization is not sufficient
validation.

## Submission assets checklist

- [ ] Public or reviewer-accessible repository.
- [ ] Reproducible README and environment instructions without secrets.
- [ ] B1 evidence matrix with explorer links and raw outcomes.
- [ ] B2 restart/UNKNOWN/duplicate-prevention evidence.
- [ ] Diagram of root key, limited key, AccountKeychain, runner, journal, and RPC.
- [ ] Pitch video of no more than 2 minutes.
- [ ] Separate demo of no more than 3 minutes.
- [ ] English project description, founder details, location, logo, and user plan.
- [ ] Honest inventory of code that existed before the contest and work completed
  during the contest.
- [ ] Final link/access check and portal confirmation.

## Primary references

- [Tempo connection details](https://tempo.xyz/developers/docs/quickstart/connection-details)
- [Tempo TypeScript SDK](https://tempo.xyz/developers/docs/sdk/typescript)
- [Tempo T3 upgrade](https://tempo.xyz/developers/docs/protocol/upgrades/t3)
- [AccountKeychain specification](https://tempo.xyz/developers/docs/protocol/transactions/AccountKeychain)
- [Viem permission guide](https://viem.sh/tempo/actions/accessKey.signAuthorization)
- [TIP-1011](https://tips.sh/1011)

## Build disclosure placeholder

Before final submission, state precisely:

- which code, if any, existed before the contest;
- which modules and tests were written during the contest;
- which third-party SDKs/protocols were used;
- how AI assistance was used;
- which claims are based on unit tests, testnet transactions, and external user
  conversations respectively.
