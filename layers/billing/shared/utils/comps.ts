// Limits on comped access that BOTH sides need to agree on.
//
// In `shared/` rather than `server/utils/` because the admin console builds its
// "how many passes" selector from the same ceiling the endpoint validates
// against. It lived in two places — `MAX_COMP_PASSES` on the server and a
// hand-typed `MAX_PASSES = 12` in the page — which is a silent failure waiting
// to happen: raise one and the UI offers an option the API rejects, lower one
// and an option quietly disappears from the form with no error anywhere.

/**
 * Ceiling on ONE grant — nothing more.
 *
 * Worth being precise, because the obvious reading is wrong: this does not
 * bound how much comp access an account can accumulate. Grants stack, so twice
 * this is two clicks away and there is no cumulative limit anywhere. What the
 * bound actually buys is that a slip of the finger cannot hand out a year, and
 * that anything larger has to be a deliberate, repeated, individually-audited
 * act rather than one absent-minded selection.
 *
 * The cumulative case is handled by the audit trail and by revokeCompPass(),
 * not by a number.
 */
export const MAX_COMP_PASSES = 12
