import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { encode } from "@auth/core/jwt";
import { isLoopbackIpv4 } from "./local-host.js";

export interface AuthJsAdapterOptions {
  env?: NodeJS.ProcessEnv;
  secret?: string;
}

export interface MintAuthJsSessionInput {
  role: string;
  email: string;
  appBaseUrl: string;
  storageStatePath: string;
  userId?: string;
  name?: string;
  picture?: string;
  secret?: string;
  cookieName?: string;
  secureCookie?: boolean;
  ttlSeconds?: number;
}

export interface MintedAuthJsSession {
  role: string;
  email: string;
  subject: string;
  storageStatePath: string;
  cookieName: string;
  appOrigin: string;
  expiresAt: number;
}

export class AuthJsAdapterError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AuthJsAdapterError";
  }
}

function isLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower === "::1" || isLoopbackIpv4(lower);
}

function appUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new AuthJsAdapterError("authjs-app-not-local", `Auth.js minting requires a local appBaseUrl; got unparseable "${baseUrl}".`);
  }
  if (!isLocalHostname(url.hostname)) {
    throw new AuthJsAdapterError(
      "authjs-app-not-local",
      `Auth.js minting refuses a non-local appBaseUrl (host=${url.hostname}); sessions may only be minted for localhost or 127.0.0.1.`
    );
  }
  return url;
}

function secretFor(input: MintAuthJsSessionInput, options: AuthJsAdapterOptions): string {
  const env = options.env ?? process.env;
  const secret = input.secret ?? options.secret ?? env.AUTH_SECRET ?? env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new AuthJsAdapterError("authjs-secret-missing", "Auth.js minting requires AUTH_SECRET, NEXTAUTH_SECRET, or --secret.");
  }
  return secret;
}

function cookieNameFor(input: MintAuthJsSessionInput, url: URL): string {
  if (input.cookieName) return input.cookieName;
  const secure = input.secureCookie ?? url.protocol === "https:";
  return secure ? "__Secure-authjs.session-token" : "authjs.session-token";
}

async function writeCookieStorageState(input: {
  path: string;
  url: URL;
  cookieName: string;
  value: string;
  expiresAt: number;
}): Promise<void> {
  await mkdir(dirname(input.path), { recursive: true });
  await writeFile(
    input.path,
    `${JSON.stringify(
      {
        cookies: [
          {
            name: input.cookieName,
            value: input.value,
            domain: input.url.hostname,
            path: "/",
            expires: input.expiresAt,
            httpOnly: true,
            secure: input.cookieName.startsWith("__Secure-") || input.url.protocol === "https:",
            sameSite: "Lax"
          }
        ],
        origins: []
      },
      null,
      2
    )}\n`
  );
}

export class AuthJsAuthAdapter {
  readonly id = "authjs" as const;

  constructor(private readonly options: AuthJsAdapterOptions = {}) {}

  async mintSession(input: MintAuthJsSessionInput): Promise<MintedAuthJsSession> {
    const url = appUrl(input.appBaseUrl);
    const cookieName = cookieNameFor(input, url);
    const ttlSeconds = input.ttlSeconds ?? 3600;
    const now = Math.floor(Date.now() / 1000);
    const subject = input.userId ?? `ghost-${randomUUID()}`;
    const jwt = await encode({
      token: {
        sub: subject,
        email: input.email,
        name: input.name ?? input.email.split("@")[0],
        picture: input.picture,
        role: input.role,
        iat: now,
        exp: now + ttlSeconds
      },
      secret: secretFor(input, this.options),
      salt: cookieName,
      maxAge: ttlSeconds
    });

    await writeCookieStorageState({
      path: input.storageStatePath,
      url,
      cookieName,
      value: jwt,
      expiresAt: now + ttlSeconds
    });

    return {
      role: input.role,
      email: input.email,
      subject,
      storageStatePath: input.storageStatePath,
      cookieName,
      appOrigin: url.origin,
      expiresAt: now + ttlSeconds
    };
  }
}
