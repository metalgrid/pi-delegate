# Playbook: Investigation

Use for a read-only question: how does X work, why was Y built this way, are we sure about Z.

This playbook replaces Stages 1–5. Make no code changes. The deliverable is a cited answer.

1. Restate the question in one sentence. Name what evidence would settle it.
2. Delegate bounded reconnaissance to `scout`. Run independent questions in parallel. Give each scout one question and one area.
3. Read the primary sources yourself: the code paths, tests, and history the scouts surface. Do not relay scout summaries unchecked.
4. For a "why" question, check `git log` and blame for the change that introduced the behavior. Record what the history shows and what it does not show.
5. For an "X or Y" question, do not ask the user to guess an observable fact. Measure it, run it, or read the artifact, then recommend from the result.
6. Answer with citations: exact `file:line` for code claims, commit hashes for history claims. Label each claim `measured` (you ran or read it directly), `inferred` (follows from cited evidence), or `guess` (no direct evidence). Name any question the evidence could not settle.
