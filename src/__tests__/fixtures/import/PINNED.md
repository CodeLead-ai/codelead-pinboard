# Pinned — waiting on Robin

The short list of what needs Robin's review or answer, newest first. Each line links to
the full context; everything else that is open but not Robin's to decide stays in
`DECISIONS-PENDING.md`.

## For action

1. **Ask the partner two lists** (spec §5 O2, your answer to Q2.1): their last ten
   application requests (to choose the first building blocks) and their last ten modernization
   enquiries by type (to weight the taxonomy in §3.1).

## For decision

- **0j — KettleBook Desk (side project): BUILT 2026-09-29 (0.1.0, fifteen commits, `{{WORKSPACE}}/kettlebook-desk`); left: the name, and what 0.2 should add.** Spec `docs/kettlebook-desk-spec-2026-09-29.md`
  (§1 the Electron decision, lines 5–7; §3 the feature list by priority, lines 72–95) and the
  repository (`{{WORKSPACE}}/kettlebook-desk` proposed).

- **0s — W4 merged (2026-10-03 00:09Z): six overlay entries to review, and one disputed target.** The old edit-profile form's submit cannot fire (`sampleapp-pilot/SampleApp.Game/Views/Player/EditProfile.cshtml:25`); the model's five gate findings are 0r's decision 2.

- **0r — The W5 design: review it, and seven decisions (2026-10-02).** `docs/w5-design-2026-10-02.md`: the seven rulings are section 2 (lines 29–66); the decisions are section 9 (lines 446–491).

## For review

0. **Partner feedback spec** — reviewed 2026-09-18; your answers are folded into a decisions
   block at the top of `docs/partner-feedback-2026-09-17-spec.md`.

## For decision

4. **EF Core migration task on ShopSample** needs `dotnet ef` (`DECISIONS-PENDING.md`):
   install it and run the schema-change task as task 3, or keep migrations for SampleApp.

## Answered (for the record)

- **0p — ANSWERED 2026-10-02 (Robin): "yes, follow the intent and hide it until initialize."** The game menu stays hidden until initialize has answered.
- SQL Server for the pilot: container on the Mac — Colima (MIT), OrbStack rejected on
  licence. Done; database up.
