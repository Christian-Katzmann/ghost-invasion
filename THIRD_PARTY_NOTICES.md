# Dependency and license review

The bundled Ghost Invasion runtime source is copyright 2026 Christian Katzmann under its existing MIT license. Both upstream LICENSE files are preserved. RUNTIME_PROVENANCE.json records the exact committed source revision and source-file digests; the core-only package manifest is explicitly transformed to pin dependencies and prevent npm publication.

Original plugin instructions, packaging code and documentation are copyright 2026 Christian Katzmann and now carry the publisher-approved MIT grant in the root LICENSE. Upstream runtime and third-party notices remain unchanged.

The archive contains no third-party npm implementation or browser binaries. The following exact public npm packages are installed using the committed lockfile (including dev/optional entries). Their recorded licenses remain theirs; installed packages include their own license files. DEPENDENCIES.json records each public registry URL and integrity hash. No private registry, private source package, local file dependency or developer path is required.

| Package | Version | Recorded license |
| --- | --- | --- |
| @auth/core | 0.41.3 | ISC |
| @panva/hkdf | 1.2.1 | MIT |
| @types/node | 22.19.19 | MIT |
| ajv | 8.20.0 | MIT |
| commander | 14.0.3 | MIT |
| fast-deep-equal | 3.1.3 | MIT |
| fast-uri | 3.1.8 | BSD-3-Clause |
| fsevents | 2.3.2 | MIT |
| jose | 6.2.12 | MIT |
| json-schema-traverse | 1.0.0 | MIT |
| oauth4webapi | 3.8.8 | MIT |
| playwright | 1.56.1 | Apache-2.0 |
| playwright-core | 1.56.1 | Apache-2.0 |
| preact | 10.24.3 | MIT |
| preact-render-to-string | 6.5.11 | MIT |
| require-from-string | 2.0.2 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| undici-types | 6.21.0 | MIT |
| yaml | 2.9.0 | ISC |

Playwright installs Chromium headless shell separately from its download infrastructure. Chromium and its embedded components have separate notices/licenses distributed with the browser; no browser redistribution occurs in this archive. The pinned Playwright version is inherited from the runtime. npm audit does not assess browser/OS security or establish a security certification. Keep the host/browser maintained before expanding beyond disposable test use.

The local dependency audit on 2026-09-30 reports zero npm advisories for this pinned package graph. That is a time-specific registry result, not a warranty. The runtime update moved @auth/core to 0.41.3 and fast-uri to 3.1.8 to resolve previously reported advisories. No paid provider SDK is required by the supported local workflow.
