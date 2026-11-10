# Poker Study repository instructions

Read SPEC.md and PLAN.md before editing. Keep the rules engine free of browser APIs. Keep the image adapter separate from confirmed game state. Keep simulation and completed-hand review as the product boundary. Reject live poker connections, overlays, continuous capture, automated actions, and telemetry. Image upload is allowed only through the opt-in, per-photo cloud recognition endpoint described in SPEC.md; keep the API key on the server and never log or store image bytes.

Use one writer per task and branch once this folder is under Git. Before a task, record its owner, base commit, allowed paths, acceptance criteria, and required checks. Use separate branches or worktrees for independent tasks. Coordinate any shared contract change before either writer edits it. Preserve existing user changes and inspect the working tree before editing.

Run npm run check for changes to code. Add deterministic fixtures for rules and equity changes. Use synthetic or consented, sanitized fixtures for vision. Include the commands and results in each handoff. If a check cannot run, record the reason and any skipped coverage.

Have the other agent review the diff against the specification and tests. Keep the reviewer read-only unless ownership is explicitly transferred. Report changed files, assumptions, known gaps, and the next action. The user controls merge, deployment, and any scope change. Keep credentials, raw photos, and personal hand histories out of Git.

Codex uses AGENTS.md for project guidance. CLAUDE.md imports it so both agents share the same instructions. See [Codex repository instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and [Claude Code project memory](https://code.claude.com/docs/en/memory).
