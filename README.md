# Ghost Invasion

![Ghost Invasion](assets/ghost.png)

Find reproducible bugs in your local test app with repeatable test journeys, clear failure evidence and replays you can run after a fix. Run repeatable browser tests with synthetic data, inspect reports and traces, and check your fix against the same test.

Ghost Invasion runs deterministic Playwright journeys against an explicitly authorized disposable local app and records evidence. This skills-only Codex plugin bundles its real TypeScript runtime; it needs no private checkout, global CLI or MCP service. Version 0.2.0 is a review candidate, not an assertion of marketplace approval.

## Host requirements and installation

Use Node.js 22+, npm 10+, Python 3 for archive assembly, and a Playwright-supported macOS/Linux host. Review verification was performed on macOS with Node 22.22.0 and Chromium headless shell pinned by Playwright 1.56.1. Linux needs the host libraries required by Playwright. This candidate also passed all 160 packaged runtime tests and its disposable reviewer fixture on Linux with Node 24.19.0 and official pinned Chromium 141.0.7390.37. Windows is not supported by this package's shell/process lifecycle checks. Docker is not required for the supported local-only workflow.

From `skills/ghost-invasion/runtime`:

```sh
npm ci --ignore-scripts
npm run build
npm exec -- playwright install chromium --only-shell
npm test
node scripts/reviewer-fixture.mjs /absolute/path/to/local-evidence
```

Dependency setup uses the public npm registry and Playwright browser CDN. No runtime source is downloaded and no API key is needed. Review `PRIVACY.md` before running against any user app. A dependency install must not be mistaken for plugin execution approval.

## Reviewer procedure

1. Unpack the archive into a fresh directory. Confirm `plugin.json`, `skills/ghost-invasion/SKILL.md`, runtime source, package lock, MIT runtime license, provenance, and dependency inventory exist.
2. Run the commands above. Tests cover authorization, origin/redirect denial, WebSocket blocking, service worker blocking, reset redirect denial, planner/schema and runner regressions. The package excludes two upstream tests tied to monorepo demo/skill wrappers; those excluded tests are not part of this packaged test result.
3. Read the fixture `review-receipt.json`: the known duplicate-write fault must appear in the first and same-seed replay run; the fixed control must pass; six resets must restore the seeded record; zero dollars spent; no agent-memory files; owned server stopped. Inspect `report.json`, trace ZIP and DB-diff files, not just the receipt.
4. For a real app, follow the skill. The target must be disposable, unauthenticated and at numeric `127.0.0.1`. Review the plan and reset endpoint before `authorize-local`. Run only `--local-only --quick --budget-usd 0 --repro-budget 0`, with explicit scheduled-session/worker caps. Every plan edit invalidates authorization. The reset endpoint is called before and after the run.

## Limits

The supported safety boundary constrains browser HTTP requests to the authorized origin, rejects off-origin redirects, blocks WebSockets and service workers, and prevents runtime API requests from following redirects. It is not an OS sandbox, full Chromium network firewall, or containment of the app backend/reset server. Other browser network mechanisms are not claimed as isolated. A same-origin backend could forward requests elsewhere; use an app that cannot contact real services. The gate scans for recognized credentials, not every possible secret. Only synthetic data and a trusted disposable backend are supported. No claim of production safety or real-user realism follows from fixture success.

The bundled legacy commands remain upstream source for transparency. They are outside this plugin's supported workflow. A Docker canary cannot establish that a host-run app/browser uses that container boundary. Memory writes now require an explicit flag and user request. No model calls, paid services, MCP server, hooks, watcher or telemetry are used by the supported workflow.

## Packaging and review status

Run `python3 scripts/build-package.py --output /absolute/path/ghost-invasion.zip` from this source plugin directory. The builder includes only manifest, public documentation and runtime source/lock/tests; generated evidence, `.ghost`, dependencies and build output are excluded. Rebuild after any source change.

The [public privacy policy](PRIVACY.md) covers this version’s local-only workflow. OpenAI submission review is still pending. Original package instructions and documentation now carry the publisher-approved MIT grant. The runtime and dependencies keep their existing licenses. Approved publisher artwork is included.

Session caps count scheduled journeys. A pristine baseline and a failure-trace retry can each create one additional browser context per scheduled session, for at most three times the authorized session cap (maximum 60 contexts); workers remain capped at two. Reproduction-budget reruns are disabled. Local CPU/time usage is not a billable API budget.

## Private support

Contact christian@katzmann.dk with a minimal description. Do not send secrets, production data or unreviewed traces. See [privacy policy](PRIVACY.md), [MIT license](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md). OpenAI directory review is not yet complete.
