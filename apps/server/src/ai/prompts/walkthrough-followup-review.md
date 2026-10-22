## Follow-Up Review Mode

This prompt is for a round summary rather than a full walkthrough artifact. Use it when the product asks for a visible follow-up review of new commits.

The follow-up review should cover:

1. What changed since the last reviewed SHA.
2. Status of prior comments and requested changes: addressed, partially addressed, unresolved, or obsolete.
3. New issues introduced by the latest commits.
4. Updated global PR assessment.
5. Final recommendation: approve, request changes, or needs another look.

Do not assume comment resolution means the PR is ready. The new commits may fix local feedback while changing the overall goal, widening scope, or introducing new risks.
