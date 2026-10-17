# Playbook: Bug Fix

Use for a reported defect. This playbook runs before Stage 2 and shortens Stage 1.

1. Reproduce the defect first, on the real surface the user sees (the failing command, test, endpoint, or UI flow). Capture the exact symptom: input, observed output, expected output. If you cannot reproduce it, stop and report what you tried; do not fix an unobserved defect.
2. Find the root cause: the first place the system went wrong, not the place the symptom surfaced. Grep every caller of the functions on the failing path. A guard at the symptom counts as a fix only when the state it handles is legitimate.
3. Write a short plan: symptom, reproduction, root-cause hypothesis, fix scope, and tests. Get user approval as in Stage 1. Skip the architect review loop only when the fix stays inside one component and changes no design, interface, or data shape; record the skip and its reason.
4. Where a cheap local test path exists, add a failing test that reproduces the defect before the fix. The test must fail on the current code for the defect's reason.
5. Implement through Stages 2–5 at the defect's scale. Keep the fix at the root cause and out of unrelated code.
6. Verify by rerunning the original reproduction from step 1, then the full relevant test suite. The reproduction output is the evidence; "tests pass" alone is not.
7. If two fixes that share one premise fail, stop fixing. Write the premise down and test it directly before writing a third fix that assumes it.
