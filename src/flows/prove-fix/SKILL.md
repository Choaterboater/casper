---
name: prove-fix
description: Add a test that fails without the fix and passes with it, so the bug stays fixed. Loads only when the user picks it after a receipt.
disable-model-invocation: true
casper-flow:
  when: after-receipt
  rule: prove-fix
  label: Add a test that proves this bug stays fixed
  cost: tokens
---
# Prove the fix

Adapted and trimmed from obra/superpowers test-driven-development (MIT, Copyright (c) 2025 Jesse Vincent).

The last change fixed a bug, and the checks pass, but no test shows the fix works: the tests
pass without the change too. Add one test that proves the bug stays fixed.

1. Find the smallest input that showed the bug. Use the request's own names and values.
2. Write one test for that input, next to the tests that already cover this code.
   - One behavior per test, with a name that says what should happen.
   - Test the real code. Use a fake only where the real thing cannot run here
     (a network device, a paid service, the clock).
3. Check that the test fails on the code without the fix. If you cannot run the old code, say
   so plainly; Casper compares with and without the change itself.
4. Run it on the code with the fix. It must pass.
5. Run the project's whole test command, not only the new test. Name any other failure you see.

Do not change the fix itself unless the new test shows it is wrong. Do not add features,
tidy other code or rename things.

When you finish, say in one or two lines which test you added and what input it uses.
