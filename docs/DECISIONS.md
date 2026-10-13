# Architecture and trust decisions

Last updated: 2026-10-05

Only decisions that affect behavior, security, or evidence belong here.

## D-001 — Moderato is the only MVP network

**Status:** accepted.

The MVP targets Tempo Testnet (Moderato), chain ID `42431`, through
`https://rpc.moderato.tempo.xyz`. The default token is pathUSD at
`0x20c0000000000000000000000000000000000000`. A permission plan for another
chain fails closed. Mainnet is not an implicit fallback.

**Why:** B1 evidence must describe one reproducible environment and must not confuse
test funds with production value.

## D-002 — Protocol-enforced least privilege is the product boundary

**Status:** accepted, not yet B1-proven.

The limited key is bound to:

- Moderato chain ID;
- one TIP-20 token;
- `transfer(address,uint256)` only;
- exactly one contractor recipient;
- a positive bigint limit in atomic units;
- a fixed period in seconds;
- a finite future expiry.

An empty recipient list, unrestricted call scope, unlimited spend policy, extra
selector, extra target, or zero/non-expiring bound is rejected as incompatible
with the product promise.

## D-003 — Planning and inspection do not sign

**Status:** accepted.

`permission plan` produces deterministic JSON and a fingerprint, including payer
and access-key signature type, but does not sign or broadcast. `permission inspect`
reads one block of on-chain state; `permission verify` compares it with the plan and
fails closed on mismatches. The owner alone approves the exact authorization in a
wallet. A plan or successful readback is not called B1 proof until the negative-call
matrix is complete. An optional public review file is created once and cannot be
silently overwritten, so the owner can retain exactly what was approved.

## D-004 — The root key never enters the runner

**Status:** accepted.

The payer's root key stays in the wallet. The project never receives or stores it.
For the local testnet runner, `access-key-generate` writes one dedicated P256 key
to an explicitly chosen `0600` file ignored by Git. The key is not printed, put in
SQLite, or included in plans, logs, or evidence. The journal contains identifiers
and outcomes, not signing material. This local file is a compromise for a
payer-controlled hackathon prototype; a production version needs OS-backed key
storage and a separate custody review.

## D-005 — Amounts are atomic bigint values

**Status:** accepted and locally implemented.

Authorization limits, invoices, transfers, fees, and comparisons use integer atomic
units. JSON and storage use canonical base-10 strings. Token decimals come from a
verified token metadata read and affect display only. Floating-point arithmetic is
forbidden in money paths.

## D-006 — Unknown broadcast outcomes fail closed

**Status:** accepted and represented in the domain state machine; end-to-end proof
pending.

`SUBMITTED` means only that an RPC accepted or returned a transaction hash.
`CONFIRMED` is required before an invoice becomes `PAID`. If the process cannot
determine whether broadcast/inclusion happened, it records `UNKNOWN`, retains the
original attempt/hash, and blocks a replacement payment until reconciliation.

## D-007 — B1 is an evidence gate, not a code-complete label

**Status:** accepted.

B1 requires an owner-signed testnet authorization, on-chain readback, one permitted
payment, negative direct calls for every claimed restriction, period and expiry
boundary observations, concurrency behavior, and revocation. Mocks, TypeScript
types, unit tests, `doctor.b0ReadReady`, and a green UI are insufficient.

## D-008 — B2 starts local and single-runner

**Status:** provisional.

SQLite is the initial journal. The intended MVP has one payer-controlled runner.
The journal must still use atomic reservation and database constraints so an
accidental second process fails safely. A hosted multi-tenant runner is a separate
trust decision and is out of scope.

## D-009 — No custom contract unless native enforcement fails

**Status:** accepted.

Tempo T3 AccountKeychain and the Viem Tempo extension are the primary mechanism.
A custom contract is not added pre-emptively. If B1 demonstrates that the native
surface cannot enforce the exact promise, the owner must approve a revised trust
model before implementation continues.

## References

- [Tempo connection details](https://tempo.xyz/developers/docs/quickstart/connection-details)
- [Tempo TypeScript SDK](https://tempo.xyz/developers/docs/sdk/typescript)
- [T3 network upgrade](https://tempo.xyz/developers/docs/protocol/upgrades/t3)
- [AccountKeychain specification](https://tempo.xyz/developers/docs/protocol/transactions/AccountKeychain)
- [Viem access-key authorization](https://viem.sh/tempo/actions/accessKey.signAuthorization)
