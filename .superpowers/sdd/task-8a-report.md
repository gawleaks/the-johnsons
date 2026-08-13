# Task 8a Report

## Status
Done.

## Files
- `src/policy/config.ts`
- `src/policy/prompts.ts`
- `test/policy/config.test.ts`

## Checks
- `npm test -- test/policy/config.test.ts`
- `npm run typecheck`
- `npm run build`
- `npm test`

## Notes
- Default preset matches the requested role models/thinking levels.
- Policy validation rejects `maxReviewAttempts < 1` and reviewer mutation tools.
- Reviewer handoffs exclude developer reasoning; developer handoffs include it.
- Role prompts require structured artifacts and explicit plan-deviation escalation.
