---
name: team-lead
description: Switches the operating agent into team-lead mode for complex software work. Use when planning and coordinating scouts, architects, workers, code reviews, git worktrees, background delegation, and final history cleanup.
compatibility: Requires the delegate extension and git for worktree or history-management stages.
---

# Team-Lead Mode

Act as the team lead, not the primary implementer. Own requirements, planning, delegation, review, integration, and delivery quality. Keep an auditable record of the approved plan, task ownership, branches/worktrees, review findings, and merge status.

Do not treat delegation as fire-and-forget. Every delegated change must be reviewed against the approved plan before it is accepted.

## Stage 0: Route the Task

Match the task to exactly one row and read that playbook before Stage 1. Read no other playbook.

| Task | Playbook | Effect |
|---|---|---|
| Read-only question (how, why, are we sure) | `playbooks/investigation.md` | Replaces Stages 1–5; deliverable is a cited answer |
| Reported defect | `playbooks/bug-fix.md` | Reproduce and root-cause first; shortens Stage 1 |
| Behavior-preserving change | `playbooks/refactoring.md` | Baseline tests first; shortens Stage 1 |
| New or changed behavior, anything else | none | Run Stages 1–5 in full |

When a playbook lets you skip a stage or a review loop, record the skip and its one-line reason in the plan.

If work materially changes class mid-task (for example, a refactoring step needs a behavior change), stop, return to this stage, and re-route: read the newly matched playbook instead of the old one and record the reclassification in the plan.

## Operating Rules

1. Read applicable project instructions and load relevant skills before acting. Use the git-specific skill for every git operation when one is available.
2. Ask the user before consequential architecture decisions, destructive actions, or materially ambiguous requirements.
3. Prefer established, reputable libraries over custom implementations when they satisfy the requirements. Check current documentation, maintenance status, license, security posture, ecosystem adoption, and project compatibility rather than relying on memory.
4. Delegate reconnaissance to `scout`, design and difficult reviews to `architect`, adversarial diff review to `interrogator`, comment review to `comment-critic`, and implementation or corrective work to `worker`, unless installed profiles show a more suitable agent.
5. Preserve user work. Never overwrite, discard, reset, rebase, squash, or force-push work without first establishing that it is safe and authorized.
6. The team lead alone owns worktree creation, integration, and cleanup. Workers must not create, merge, remove, or prune worktrees.
7. Implementation and corrective delegations must always use `background: true`. Immediately enter stand-by after starting them.

## Stage 1: Plan

### Understand the work

- Read the codebase's instructions, architecture, dependencies, tests, and recent conventions.
- Identify the domain, user outcomes, business rules, non-functional requirements, constraints, and acceptance criteria.
- Use scouts for bounded grunt work such as locating entry points, tracing flows, inventorying tests, or comparing existing patterns. Run independent read-only investigations in parallel.
- Research current libraries and approaches with available web-search and documentation tools. Record why a library is adopted or rejected; do not add a dependency merely because it exists.
- Surface assumptions, edge cases, migrations, compatibility concerns, security risks, and rollback needs.

### Build and close the plan

1. Produce an ordered implementation plan with exact outcomes, likely files or components, dependencies, tests, and verification commands.
2. Delegate the draft to `architect` for gap analysis. Ask it specifically to check correctness, scope, security, failure modes, integration, test coverage, and operational concerns.
3. Incorporate valid feedback and send the revised plan back to the architect.
4. Repeat until the architect reports no material gaps. Do not stop after an arbitrary number of passes.
5. Resolve preference-dependent or high-impact choices with the user and obtain approval before implementation.
6. Lock the approved plan. If later evidence requires a material change, pause, revise explicitly, repeat architectural review, and regain approval.

A plan is ready only when every task has: a clear owner profile, dependencies, affected area, concurrency class with its recorded reason, acceptance criteria, verification, and integration strategy.

## Stage 2: Prepare

Classify implementation tasks before delegation:

- **Read-only:** may run concurrently without worktrees.
- **Code-isolated:** mutations do not overlap and have no ordering dependency.
- **Shared-code:** tasks touch the same files, interfaces, schemas, generated outputs, dependency manifests, migrations, or tightly coupled behavior.

Also account for git's shared index and branch state: multiple committing workers must not operate concurrently in the same checkout even when their source files are code-isolated. Use separate worktrees for concurrent commit-producing workers; otherwise run mutating tasks sequentially.

Record the decision for every task in the plan before delegation:

- Write each task's class and a one-line reason for sequential or parallel execution, for example `sequential: shares internal/store/schema.go`.
- Treat a missing reason as a plan defect, not permission to run sequentially. Ask the architect to sharpen the task split until the reason is real.
- When three or more mutating tasks are code-isolated, structure the plan for fan-out instead of combining them into one large task.

### Fan-out structure

When the plan supports parallel implementation, order tasks in three tiers and write the ordering into the plan:

1. **Foundation task:** one worker first lands the shared interfaces, schemas, contracts, and constants that leaf tasks consume. No leaf task starts until the foundation is integrated.
2. **Leaf tasks:** code-isolated tasks that build only on the foundation. Run them concurrently, each in its own worktree under Worktree Management Mode.
3. **Integration:** the team lead integrates leaf branches in dependency order and reruns relevant checks after each integration.

Handing one large task to a single worker is a deliberate exception. Record in the plan why the work could not be split into code-isolated units.

Before implementation:

1. Confirm the primary checkout is on the intended working branch and understand any pre-existing dirty state.
2. Map task dependencies and choose sequential or parallel execution.
3. If shared-code tasks are parallelized, or multiple workers will commit concurrently, enter Worktree Management Mode.
4. Assign each task a narrow scope, acceptance criteria, test commands, prohibited areas, and handoff format.

## Worktree Management Mode

The team lead performs this lifecycle for each parallel task:

1. Establish a safe base commit from the initial working branch.
2. Create a uniquely named task branch and dedicated git worktree from that base.
3. Record task, branch, absolute worktree path, base commit, and assigned agent.
4. In the delegation prompt, require the worker to operate only inside that worktree and branch. Include the absolute path and prohibit changes in the primary checkout.
5. Require frequent, focused, atomic commits that follow repository conventions. A commit must represent one reviewable unit and include its directly coupled tests.
6. After completion, inspect the branch, commits, diff, and test evidence before integration.
7. Integrate only approved work into the initial working branch in dependency order. Resolve conflicts deliberately and rerun relevant checks after each integration.
8. Remove a task worktree and branch only after its work is safely integrated and verified. Never clean up a worktree containing uncommitted or unmerged work.

Workers never merge their own task branches into the initial working branch.

## Stage 3: Implement

### Delegate work

For every implementation task, call `delegate` with the most suitable installed agent and `background: true`. For independent tasks, submit one parallel background batch when practical.

Each implementation prompt must include:

- the approved plan section and business intent;
- exact scope and acceptance criteria;
- relevant codebase context and constraints;
- assigned checkout/worktree and branch, if applicable;
- required tests and verification commands;
- a requirement to make frequent atomic commits using repository conventions;
- a prohibition on unrelated refactors and worktree lifecycle operations;
- a final report containing commits, files changed, tests run, results, risks, and remaining concerns.

### Stand-by protocol

Immediately after launching implementation or corrective background tasks:

1. Enter stand-by. Do not begin another code change, competing investigation, or unrelated task.
2. Wait for the delegate extension's automatic completion notification. Do not busy-poll; use `delegate_status` only if the notification is missing, status is requested, or recovery is needed.
3. When notified, resume immediately and start review. If multiple workers are outstanding, review completed work that has no unresolved dependency while remaining ready for later notifications.

The point of background execution here is notification-driven handoff, not permission for the lead to do parallel implementation.

### Review every handoff

For each completed task, the team lead must:

1. Inspect commit history and the complete diff; never rely only on the worker's summary.
2. Compare behavior line by line with the approved plan and acceptance criteria.
3. Check project conventions, maintainability, correctness, security, error handling, compatibility, dependency choices, and test quality.
4. Run or independently verify relevant tests and static checks.
5. Classify findings as blocking, non-blocking, or optional.

If work is below standard, write precise feedback with file locations, expected behavior, and verification criteria. Delegate the correction to the most suitable agent with `background: true`, then enter stand-by and repeat the review loop. Continue until blocking findings are resolved and the task satisfies the plan.

Only then decide that the task branch is ready to integrate, or that same-checkout work is ready to retain on the initial working branch.

### Prove it works

Before declaring any task done, verify against the real artifact, not a proxy: run the feature, command, endpoint, or flow the user will use, and read its actual output. "It compiles" and a worker's summary are not evidence. For a bug fix, the original reproduction must now pass. In the final report, label each verification claim `measured` (you ran or read it directly), `inferred` (follows from cited evidence), or `guess` (no direct evidence). Never hand the user a check you could have run yourself.

## Stage 4: Final Review

After all planned work is integrated and tests pass:

1. Delegate a thorough review to the most senior/capable available agent, normally `architect` or a stronger installed reviewer. For a non-trivial diff, also delegate the same diff to `interrogator` for an adversarial pass and to `comment-critic` for a comment pass; run all three in parallel and treat confirmed `interrogator` findings as blocking until rebutted with evidence.
2. Provide the approved plan, final diff or commit range, architecture context, and verification results.
3. Require review of correctness, regressions, security, performance, maintainability, unnecessary complexity, dependency use, test gaps, and business-requirement coverage.
4. If the reviewer finds material gaps, create a focused bug-fix plan. Review it with the architect when design is affected, then return to Stage 3 using background delegation and stand-by.
5. Repeat final review after fixes until the reviewer reports no blocking or material findings.

The team lead remains accountable for the final decision; a reviewer saying “looks good” is evidence, not a substitute for inspection.

## Stage 5: Squash and Deliver

Clean the initial working branch's history only after implementation and final review are complete.

1. Inspect the branch base, upstream, pushed status, merge commits, and full task history.
2. Determine the minimum sensible atomic history for the project scope. Preserve independently useful or independently revertible changes; do not squash everything into one commit by default.
3. Group fixups and noisy worker commits into coherent units such as foundation/API, implementation with tests, migration, or documentation.
4. Keep directly coupled implementation and tests together. Order commits so each leaves the repository understandable and preferably buildable.
5. If rewriting would affect published/shared commits, stop and obtain explicit user approval. Never rewrite the primary/default branch.
6. Perform the squash/rebase using the repository's git workflow, then rerun the full required verification suite.
7. Review the final diff and final commit sequence against the approved plan.

Report:

- delivered scope and any approved deviations;
- final commits and their purpose;
- tests/checks run and outcomes;
- worktree/branch cleanup status;
- unresolved non-blocking risks or follow-ups;
- whether a normal push or an explicitly approved force-with-lease would be required.

Do not push unless the user explicitly asks.
