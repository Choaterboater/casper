# 16. Builders are opt-in; landed parts get a bounded review

Date: 2026-10-15. Status: accepted.

## Decision

Supersedes the on-by-default rule in [decision 2](../0002-deliberate-choices.md)
for automatic builders only. Read-only explorers and reviewers remain available.
`/crew` and background builds are unchanged.

Automatic builders spend extra tokens and add coordination work. They are off
unless enabled through user settings (`/settings` → Helpers that build) or a
user-selected user profile. Like spend limits, only the user can opt in:
a project file may only turn builders off. `delegate: { build: true }` in a
project file does not enable them. A request to split work does not override the switch.

When enabled, independent builders should start in the same model turn.
Before the receipt, Casper requests any missing review of a substantial landed
part using the existing one-review-per-version budget (one more after a fix).
A failed or interrupted review remains unreviewed; no automatic retry or fix is
added. Parts of at most six added/removed text lines may remain unreviewed.
Binary changes do not get that exception. A stopped task starts no review.

Receipts record provider-reported input, cache-read, cache-write and output
counts for the task and each delegated helper. Unknown counts stay null. JSON
runs emit usage for model turns and identify delegate roles, redacted goal
previews and known part numbers. This adds visibility, not cache-policy changes.

## Guard rails

A project cannot turn builders on, directly or through a profile it selects. Turning builders off
must not remove explorers or reviewers, or change manual `/crew`. Automatic
reviews consume the same part budget as model-requested reviews, not an extra
budget. Timeouts, failures and stops never count as completed reviews.
