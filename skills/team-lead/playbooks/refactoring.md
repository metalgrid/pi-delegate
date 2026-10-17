# Playbook: Refactoring

Use for a behavior-preserving change: rename, extract, inline, dedupe, or move. This playbook runs before Stage 2 and shortens Stage 1.

1. Name the behavior that must not change: public APIs, observable outputs, stored data, and error behavior. Anything not named is not protected.
2. Run the relevant existing tests on the untouched code and record the baseline result. Note where coverage of the named behavior is missing; do not write new tests yet.
3. Write a short plan: target shape, protected behavior, any missing characterization tests, and the sequence of small steps. Get user approval as in Stage 1. Skip the architect review loop only when the target shape follows an existing pattern in the codebase; record the skip and its reason.
4. Implement through Stages 2–5 in small verifiable units. Where the plan names missing characterization tests, make them the first Stage 3 task, as their own commit, before any structural change. Each unit ends with the baseline tests green. Never mix a behavior change into a refactoring commit; if a step needs one, stop and replan it as a feature or bug fix.
5. Prefer deletion: at each step, remove dead code, one-caller wrappers, and duplicate validators the new shape makes redundant.
6. Verify at the end by rerunning the baseline suite and diffing the public surface (exports, signatures, CLI or API output) against the pre-change state. Report the comparison, not just a green test count.
