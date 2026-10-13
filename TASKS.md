# Retainer tasks

Last updated: 2026-10-08

## Done

- [x] Pin Node.js `>=24`, pnpm `11.19.0`, and Viem `2.57.2`.
- [x] Pin Moderato chain ID, RPC, explorer, pathUSD, and AccountKeychain addresses.
- [x] Implement atomic bigint amount validation and display formatting.
- [x] Implement a least-privilege permission specification and plan-only CLI path.
- [x] Implement read-only Moderato doctor and permission inspection paths.
- [x] Model `RESERVED → PREPARED → SUBMITTED/UNKNOWN → terminal` attempt states.
- [x] Confirm live B0 read capability for chain, token metadata, periodic limits,
  and call scopes through the compiled CLI.
- [x] Implement and locally test the SQLite journal core: canonical atomic-value
  storage, idempotent reservation, cross-connection contention, guarded state
  transitions, `UNKNOWN` blocking, and immutable prepared transaction/hash data.
- [x] Run `pnpm check` and `pnpm build`: 12 test files and 55 tests passed, and the
  TypeScript build succeeded.
- [x] Smoke-test the offline permission plan: selector `0xa9059cbb` and the exact
  requested payer/key type/recipient were returned without signing or broadcasting.
- [x] Anchor permission readback to one block and smoke-test fail-closed verification
  against a nonexistent key; B1 correctly remained false.
- [x] Implement `journal init` with default `./data/retainer.sqlite` and smoke-test
  the compiled CLI against a temporary database; resulting file mode was `0600`.
- [x] Re-run journal initialization idempotently, pin schema version `2`, and run a
  targeted scan for non-empty private-key/mnemonic assignments.
- [x] Add a payer-controlled P256 test-key file (0600), a network adapter that
  signs before durable preparation, exact-call/Transfer receipt checks, and manual
  payment and keyless reconciliation commands.
- [x] Block reservation for inactive, expired, or undersized agreements; record
  signed authorization, receipt, and readback evidence before local activation.
- [x] Add an overwrite-safe public permission review bundle, keep terminal
  payment attempts visible, and test file-backed restart plus two-runner recovery.
- [x] Test exact Tempo receipt evidence offline, including wrong hash, chain,
  multi-call, recipient, token, amount, and duplicate Transfer events.
- [x] Prepare and simulate an exact direct owner call for Rabby without requesting
  the payer's root key. Provide a loopback-only review page and confirm it does
  not serve the local access-key file.
- [x] Confirm one owner-signed direct authorization on Moderato and activate
  the matching local draft after transaction, event, and readback checks.
- [x] Send one 0.1 pathUSD test invoice using only the dedicated P256 key;
  verify its exact receipt/Transfer event and mark it `PAID`.
- [x] Confirm bounded negative probes for over-limit, wrong-recipient,
  wrong-selector, and `approve`; record wrong-token protocol rejection.
- [x] Inject lost application response after a real 0.05 pathUSD RPC acceptance,
  reconcile the original hash keylessly, and verify no replacement attempt.
- [x] Send a same-block pair of 0.6 pathUSD attempts under a 1 pathUSD
  limit: one succeeded and one reverted; verify recipient balance.
- [x] Record read-only period replenishment and post-expiry zero-budget/scope
  observations; signed post-boundary calls remain untested.
- [x] Create project state, evidence, decisions, threat model, and submission docs.

## Doing

- [x] Integrate the journal with real transaction preparation and reconciliation
  code; live transaction evidence is still pending.
- [x] Prepare an exact owner-reviewable permission plan and B1 evidence bundle.

## Next: B1 protocol proof

- [x] Owner-side project creates a dedicated test-only access key; root key stays
  in the wallet. The key file remains local with mode `0600`.
- [x] Owner signs the exact chain/token/selector/recipient/limit/period/expiry plan.
- [x] Inspect the on-chain permission and archive plan fingerprint plus transaction.
- [x] Prove allowed payment succeeds.
- [x] Prove over-limit, wrong-recipient, wrong-selector, and wrong-token calls
  fail outside the UI. Expiry and revoked-key checks remain pending.
- [x] Exercise one same-block concurrent-limit pair and observe the later
  period readback; exact reset timing and a post-reset spend remain untested.
- [x] Record explorer links, timestamps, raw outcomes, and environment versions
  for the completed tests in `docs/EVIDENCE.md`.

## Next: B2 journal and recovery

- [x] Add agreement, invoice, and payment-attempt persistence without any key bytes.
- [x] Make invoice reservation atomic and reject a second active attempt.
- [x] Persist prepared transaction/hash before broadcast in the manual runner.
- [x] Reconcile `SUBMITTED` and `UNKNOWN` from the original transaction hash in
  local tests and one live injected-response-loss exercise.
- [x] Prove local file-backed restart recovery and accidental two-runner safety;
  repeat both with a live owner-authorized payment before the B2 gate passes.
- [x] Keep `SUBMITTED` non-terminal; mark `PAID` only after confirmed inclusion
  in one live test payment.

## Later

- [x] Add manual runner execution; enable it only for locally activated agreements.
- [ ] Add a scheduler using the same guarded function after B1 and live B2 proof.
- [ ] Add a small payer UI only after the CLI path is evidenced.
- [ ] Run one external payer/contractor test on test funds.
- [ ] Record a pitch video under 2 minutes and a separate live-product demo
  under 3 minutes.
- [ ] Complete the English application and disclose all prior/existing code.

## Explicitly out of scope

- [ ] Mainnet, fiat/off-ramp, swaps, multichain, lending/yield, taxes, worker
  marketplace, bulk payroll, hosted custody, or a custom contract without a new
  owner-approved decision.
