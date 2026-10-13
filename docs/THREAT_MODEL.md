# Threat model

Last updated: 2026-10-05

## Security objective

A stolen or malfunctioning runner key must not be able to move more than the
protocol-authorized pathUSD amount, call a different function, pay a different
recipient, continue after expiry/revocation, or cause an ambiguous invoice to be
silently paid twice. The payer's root key must never enter the runner.

This is a design and test plan, not an audit report. B1 and B2 evidence is still
incomplete.

## Assets

- payer/root-wallet authority;
- dedicated limited access key;
- payer's pathUSD balance and spending capacity;
- contractor address and agreement terms;
- invoice identifiers, amounts, and status;
- prepared transactions, transaction hashes, receipts, and remaining-limit reads;
- SQLite journal integrity and availability;
- evidence used to make demo/submission claims.

## Trust boundaries

1. **Owner wallet ↔ plan:** the human reviews and signs the exact permission.
2. **Protocol ↔ limited key:** Tempo AccountKeychain enforces key restrictions.
3. **Runner process ↔ secret source:** a dedicated test key is read from a local
   `0600` file at run time; the root wallet key remains outside this boundary.
4. **Runner ↔ RPC:** the public endpoint can fail, time out, lag, or return an error
   after a transaction was accepted.
5. **Runner ↔ SQLite:** local durable state must survive restart and reject competing
   work on one invoice.
6. **Observer ↔ explorer/evidence:** explorer UI is supporting evidence, while raw
   RPC receipts and deterministic records are the operational source of truth.

## Threats and controls

| Threat | Consequence | Current or required control | Evidence state |
| --- | --- | --- | --- |
| Root-key disclosure | Total payer compromise | Root key stays in wallet; CLI never asks for or stores it | Design rule; owner practice pending |
| Limited-key theft | Unauthorized transactions within its powers | Dedicated key, finite expiry, one token/selector/recipient, periodic limit, revocation | Planned; B1 pending |
| Unlimited or empty scope | Product promise silently disappears | Require limited policy, exactly one target/rule/recipient; inspect on-chain state | Local validation; B1 pending |
| Wrong chain or token | Payment under unintended rules/assets | Pin Moderato `42431` and pathUSD; fail closed on chain mismatch; display identifiers | Local validation + doctor evidence |
| Selector confusion (`approve`, helper, factory) | Recipient/limit bypass | Allow only TIP-20 `transfer(address,uint256)` directly; negative selector calls; no helper path | B1 pending |
| Recipient encoding mistake | Transfer to attacker | Checksummed nonzero address, exactly one recipient, on-chain scope inspection and negative test | Local validation; B1 pending |
| Decimal/float error | Overpayment or incorrect limit | Bigint atomic units, canonical decimal storage, verified token decimals for display only | Unit coverage; on-chain use pending |
| Period/expiry misunderstanding | Unexpected reset or continued authority | Period is seconds, expiry is Unix seconds; boundary tests; never call it a calendar month unless implemented | B1 pending |
| Two workers reserve one invoice | Duplicate payment attempts | Transactional reservation, uniqueness constraint, single-runner MVP, safe second-process failure | B2 provisional |
| RPC timeout after broadcast | Automatic duplicate payment | Persist attempt/hash, set `UNKNOWN`, query original attempt, prohibit replacement until reconciled | Domain rule; B2 end-to-end pending |
| RPC submit mistaken for payment | False `PAID` status | Only confirmed receipt maps to `PAID`; `SUBMITTED` stays processing | Domain rule; end-to-end pending |
| Reorg/stale RPC/inconsistent read | Incorrect status or remaining limit | Permission snapshot uses one block number/hash; receipt and exact transaction call must agree; surface uncertainty | Implemented locally; live recovery pending |
| Journal loss or tampering | Lost idempotency/recovery state | Local file permissions, backups for demo, schema constraints, migrations, integrity checks | B2 provisional |
| Secret leakage in logs/DB/chat | Key theft | Dedicated key file mode `0600`, Git ignore, no key bytes in CLI output or SQLite; never share the file | Local file tests pass; external machine unverified |
| Dependency or SDK drift | Changed encoding/semantics | Pin Viem `2.57.2`, lockfile, record Node/pnpm, verify T3 APIs against live network | B0 evidence; ongoing |
| UI masks direct-call failure | False security claim | B1 uses direct CLI/calldata outside UI; UI comes later | B1 pending |

## Important protocol caveats

- Spending limits and call scopes must both be present; either alone is insufficient.
- An unrestricted key or empty/misinterpreted recipient list is unacceptable.
- The selected transaction path must be a direct TIP-20 transfer compatible with
  the T3 enforcement semantics; B1 must reject alternative selectors and targets.
- Access-key-signed contract creation is not part of the design.
- Readback of remaining amount and period end does not alone prove the originally
  signed maximum/period. Preserve the signed plan and test the boundary.
- A periodic window is anchored to the authorization timestamp, not a calendar.
  If the payment token is also the fee token, B1 must measure whether fees consume
  the same limited budget and retain an explicit fee reserve or use sponsorship.
- A protocol spending limit bounds authority; it does not guarantee payer balance,
  service quality, invoice approval, network availability, or legal enforceability.

## Failure-state policy

| Observed state | Invoice interpretation | May create a new payment? |
| --- | --- | --- |
| Reserved/prepared, no broadcast evidence | `PROCESSING` until safely resolved | No concurrent attempt |
| RPC returned hash, receipt pending | `PROCESSING` | No |
| Broadcast may have happened, outcome unavailable | `UNKNOWN` | No |
| Confirmed successful receipt | `PAID` | No |
| Confirmed revert or proven pre-broadcast failure | `BLOCKED`/actionable failure | Only through an explicit reviewed retry policy |

## Residual risks

Even after B1/B2, the public RPC, local machine, dedicated key file, wallet, and human
review remain trusted components. The project has no external audit and currently
targets test funds only. Hosted custody, multiple users, mainnet, automatic retry,
and legal/payment-dispute handling require separate designs.

## References

- [T3 upgrade](https://tempo.xyz/developers/docs/protocol/upgrades/t3)
- [AccountKeychain specification](https://tempo.xyz/developers/docs/protocol/transactions/AccountKeychain)
- [Viem access-key authorization](https://viem.sh/tempo/actions/accessKey.signAuthorization)
- [TIP-1011](https://tips.sh/1011)
