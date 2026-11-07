# webhub — Working rules (humans and AI)

Read before any work:
- Design: `DESIGN.md` · Workflow: `docs/WORKFLOW.md` · Plan: `docs/PLAN.md` · Feature status: `docs/features/README.md`

## Rules (mandatory — details in docs/WORKFLOW.md)
- **R0 Zero-touch** — never modify files in a user's project; all config/env goes through webhub.
- **R1** — never change a `done` feature without permission (requires a user-approved CR).
- **R2** — no code before the item is `planned` (approved spec/CR in the plan). Spikes only in the scratchpad, outside the repo.
- **R3** — every spec/CR analyzes pros / cons / alternatives / impact.
- **R4** — every change updates the related documentation.
- **R5** — reports (test / review / security / manual coverage) are separate, append-only files in `docs/reports/`.
- **R6** — maximum security: secure by default, threat model in every spec, separate security review for every item.

## Workflows
- **W1 Create function:** design → ask for feedback → docs → add to plan → ask "proceed now?" (yes → W3 for this item only; no → stop).
- **W2 Change function:** same as W1, but starts with a CR and requires explicit permission.
- **W3 Execute plan:** read plan → implement (without affecting existing features) → test → code review + security review → fix critical/major until zero → next item, until the plan is complete or the user says stop.
- **W4 Manual:** analyze the real system → HTML manual that opens from disk (`docs/manual/`) → check usage coverage.

## Communication
- Talk to the user in Thai; never decide on their behalf at "ask for feedback", "proceed now?" or feature-change permission.
- Branches: `develop` (main), `feat/F-xxx-<name>`, `fix/CR-xxx-<name>`; commits reference F-xxx / CR-xxx / M-x.
