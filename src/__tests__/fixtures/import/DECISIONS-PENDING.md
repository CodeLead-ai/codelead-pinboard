# Decisions pending — Robin

One line per open decision, newest first. Full context linked.

0. **Evidence records now cover repairs and pre-proposal stops — SHIPPED 2026-09-17 17:01Z.** Nothing open.
0. **Toolchain floor is a plan-time fact (product rule, from the SampleApp after-build 2026-09-17).** Rule for `/modernize --plan`: every increment states the minimum toolchain after it lands. Not started; MVP priority is Robin's call (`modernization-pilot-reconcile.md`, Phase 3 table, last row).
0. **Harness gaps from the Muse runs (2026-09-15 04:15Z):** routes-in-plan, data-set-in-plan and page-mount protection are in. Nothing open from the Muse runs.

2. **SampleApp pilot Day-1** — **answered 2026-08-28** in `modernization-pilot-kickoff-sampleapp.md:62-70`.

## Parked (not pending)
- **DECIDED (Robin, 2026-09-17) — migration UX:** commands `/modernize --plan`, `/pin`, `/transform`, `/audit-pack`; approval per stage.
- **EF Core migration task on ShopSample needs `dotnet ef` (2026-09-16).** Not installed on this Mac. Robin's call: install the tool and run the migration task as task 3, or keep migrations for the SampleApp pilot.
- **Plan claims are beliefs until checked (ShopSample t1b–t1d, 2026-09-16).** Two upstream options, undecided: (a) a plan-claim check; (b) a member probe for external types.
- ~~Effort experiments at the end of the queue~~ superseded.
- **Off-domain 1, Tally (12:20Z): 8/8, 122.3 min, 1 retry, live oracle 32/32.**
- **QUESTION FOR ROBIN (16:07Z, from 11b inc-12/13):** the regression replay found the listing detail page rendering 0 characters after the calendar increment. Your call; nothing changed yet.

## From the Migration & Modernization spec §10 (batched; not blocking Mig-0)

Elaborated in `spec-section-10-decisions.md`; Robin answered 1, 2, 4, 5, 7 on 2026-08-28. Still open: §10.6.

- §10.1 naming ("CodeLead Modernize"; Dossier vs Assessment) — open. Answer: Yes
- §10.6 PKB roadmap placement (fold §6 into `codelead-pkb` now vs hold) — open
