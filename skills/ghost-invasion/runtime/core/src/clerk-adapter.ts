import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isLoopbackIpv4 } from "./local-host.js";

export interface MintClerkSessionInput {
  role: string;
  email: string;
  appBaseUrl: string;
  storageStatePath: string;
  testingToken: string;
  publishableKey?: string;
}

export interface MintedClerkSession {
  role: string;
  email: string;
  storageStatePath: string;
  appOrigin: string;
  testingTokenQueryParam: "__clerk_testing_token";
}

export class ClerkAdapterError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ClerkAdapterError";
  }
}

function appOrigin(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

function isLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower === "::1" || isLoopbackIpv4(lower);
}

function assertLocalApp(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ClerkAdapterError("clerk-app-not-local", `Clerk test minting requires a local appBaseUrl; got unparseable "${baseUrl}".`);
  }
  if (!isLocalHostname(url.hostname)) {
    throw new ClerkAdapterError(
      "clerk-app-not-local",
      `Clerk test minting refuses a non-local appBaseUrl (host=${url.hostname}); sessions may only be minted for localhost or 127.0.0.1.`
    );
  }
}

function assertClerkTestEmail(email: string): void {
  const [local, domain] = email.split("@");
  if (!local || !domain || !local.includes("+clerk_test")) {
    throw new ClerkAdapterError("clerk-test-email-required", "Clerk test minting requires an email alias containing +clerk_test.");
  }
}

async function writeStorageState(input: MintClerkSessionInput, origin: string): Promise<void> {
  await mkdir(dirname(input.storageStatePath), { recursive: true });
  await writeFile(
    input.storageStatePath,
    `${JSON.stringify(
      {
        cookies: [
          {
            name: "__clerk_testing_token",
            value: input.testingToken,
            domain: new URL(origin).hostname,
            path: "/",
            expires: Math.floor(Date.now() / 1000) + 3600,
            httpOnly: false,
            secure: origin.startsWith("https:"),
            sameSite: "Lax"
          }
        ],
        origins: [
          {
            origin,
            localStorage: [
              { name: "__clerk_testing_token", value: input.testingToken },
              {
                name: "ghost:clerk-test-user",
                value: JSON.stringify({
                  role: input.role,
                  email: input.email,
                  testingTokenQueryParam: "__clerk_testing_token",
                  ...(input.publishableKey ? { publishableKey: input.publishableKey } : {})
                })
              }
            ]
          }
        ]
      },
      null,
      2
    )}\n`
  );
}

export class ClerkAuthAdapter {
  readonly id = "clerk" as const;

  async mintSession(input: MintClerkSessionInput): Promise<MintedClerkSession> {
    assertLocalApp(input.appBaseUrl);
    assertClerkTestEmail(input.email);
    if (!input.testingToken.trim()) {
      throw new ClerkAdapterError("clerk-testing-token-missing", "Clerk test minting requires --testing-token.");
    }

    const origin = appOrigin(input.appBaseUrl);
    await writeStorageState(input, origin);
    return {
      role: input.role,
      email: input.email,
      storageStatePath: input.storageStatePath,
      appOrigin: origin,
      testingTokenQueryParam: "__clerk_testing_token"
    };
  }
}
