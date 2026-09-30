# Explicit local browser-origin review mode

`authorize-local` is a separate, opt-in authorization boundary for a disposable numeric-loopback application and same-origin HTTP POST reset endpoint. It binds the plan hash and target; `run --local-only` requires zero USD budget, quick mode, reproduction budget zero, resets enabled, no API volume, no authentication state or uploads, and authorized caps (at most 20 scheduled sessions and 2 workers; each scheduled session may add one baseline and one failure-trace retry context, for at most 60 total contexts).

Chromium contexts disable service workers. HTTP routing permits only the authorized origin and checks redirect destinations without automatic redirect following; WebSockets are blocked. Explicit API primitives validate origin and never follow redirects. The reset request validates origin, refuses redirects, and runs before and after the test. Secret checks and machine-memory checks remain active. Existing normal-run gate behavior remains separate and unchanged.

This boundary is browser-request isolation, not an OS sandbox, full browser network firewall or backend containment. The user's app and reset implementation remain trusted. Do not use real accounts, service credentials, production state or a target that forwards to real services. The old Docker canary does not prove that the host browser/app uses its container firewall.

`node scripts/prepare-local-plan.mjs <project-root> <http://127.0.0.1:port>` creates an unapproved example plan without overwriting one. Adapt all journeys and assertions, obtain authorization for the exact disposable app/reset, then use:

```
node core/dist/ghost-invasion.js authorize-local --cwd <project-root> --reset-path /api/reset --confirm-disposable-target --max-sessions 1 --max-workers 1
node core/dist/ghost-invasion.js run --cwd <project-root> --local-only --quick --budget-usd 0 --repro-budget 0 --sessions 1 --workers 1
```

Replay with the same run command and plan. Changed plans require renewed authorization. `scripts/reviewer-fixture.mjs` owns a disposable fixture, runs known fault/replay/fixed control, verifies actual resets and cleanup, and writes local evidence. `core/test/local-boundary.test.mjs` verifies zero requests at an off-origin sink, redirects, blocked WebSockets/service workers, and gate rejection cases. `run` writes agent memory only when explicitly requested with `--write-agent-memory`.
