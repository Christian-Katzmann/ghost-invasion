# Ghost Invasion privacy policy

## Scope

This policy covers the reviewed Ghost Invasion plugin package version 0.2.0 and its supported local-only workflow. It does not describe other versions or unsupported upstream commands. Publication of this policy does not by itself announce a software release.

The skill reads the user-selected application's relevant source and writes an editable plan, an authorization record and evidence beneath that project's `.ghost/` directory. The runtime reads its plan, configuration, recognized environment files/variables for secret detection, and existing Ghost testing facts in AGENTS.md/CLAUDE.md. It does not automatically modify agent-memory files; that optional feature requires both an explicit user request and `--write-agent-memory`.

The local-only workflow sends browser and API requests plus synthetic form input to the authorized `http://127.0.0.1:<port>` origin and HTTP POST resets to its approved endpoint. Browser HTTP redirects are checked, WebSockets/service workers blocked, stored authentication/uploads disabled, and API redirects not followed. The app backend and reset endpoint are trusted and can themselves access the network and host. This is not OS-level network isolation. Do not supply real accounts, production databases, service credentials or sensitive user data.

Reports, screenshots, video, HAR, traces, DB snapshots and reproduction files can preserve request/response and page content, including personal data displayed by a target. Redaction is best effort, not a guarantee. Evidence stays where written until the user deletes it. Users can inspect, move or delete their own `.ghost/` directory and evidence directories after stopping runs; the plugin provides no automatic retention/deletion service. Do not publish raw evidence without reviewing its contents.

Installing prerequisites contacts the public npm registry and Playwright download infrastructure, which receive normal network request metadata. The bundled source and package lock identify dependencies. The supported test workflow requires no account, API key or paid model call. It has no publisher telemetry, cloud storage, analytics, MCP server or automatic evidence upload. Codex itself may process conversation content, selected files and tool output according to the user's OpenAI product settings and applicable OpenAI terms/policy; this notice cannot change those.

Other upstream runtime commands, such as authentication helpers, discovery build commands, dashboards and legacy modes, have broader behavior and are not supported by this plugin workflow. Do not invoke them based on this privacy notice alone.

## Publisher and contact

Publisher: Christian Katzmann. Effective date: September 30, 2026. For private privacy or support requests, contact [christian@katzmann.dk](mailto:christian@katzmann.dk). Send a minimal description; do not include credentials, notebook contents, production records or raw traces. Any information you choose to send for support is processed in the publisher's existing email service to answer that request, and remains until the correspondence is deleted. Request deletion through the same address. Provider backups and mandatory retention, if applicable, can outlast live-mailbox deletion.
