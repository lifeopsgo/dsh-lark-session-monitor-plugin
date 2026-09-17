## What this changes

<!-- One or two sentences. Link the issue it closes, if any. -->

## Why

<!-- The problem this solves. For a bug, the root cause — not just the symptom. -->

## How it was verified

<!--
Name the check you actually ran. "Tests pass" is not enough on its own for a
change that touches the Host surface — say what you ran against a live Host.
-->

- [ ] `npm run check` passes
- [ ] If `src/` changed, `lib/` was rebuilt and committed
- [ ] If a Host service or the settings slot was touched, verified against a running DSH

## Regression test

<!--
If this fixes a bug, name the test that fails without the fix. State that you
confirmed it goes red before the fix is applied.
-->

## Notes for the reviewer

<!-- Anything you are unsure about, or deliberately left out of scope. -->
