import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isLoopbackIpv4 } from "./local-host.js";

export interface FirebaseAdapterOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  emulatorUrl?: string;
  projectId?: string;
  apiKey?: string;
  appName?: string;
}

export interface MintFirebaseSessionInput {
  role: string;
  email: string;
  password: string;
  appBaseUrl: string;
  storageStatePath: string;
}

export interface FirebaseAuthResponse {
  idToken: string;
  email: string;
  refreshToken: string;
  expiresIn: string;
  localId: string;
}

export interface MintedFirebaseSession {
  role: string;
  email: string;
  uid: string;
  storageStatePath: string;
  storageKey: string;
  appOrigin: string;
  emulatorUrl: string;
}

export class FirebaseAdapterError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "FirebaseAdapterError";
  }
}

function normalizeEmulatorUrl(input: string): string {
  const withScheme = /^https?:\/\//.test(input) ? input : `http://${input}`;
  const url = new URL(withScheme);
  if (!["localhost", "::1"].includes(url.hostname) && !isLoopbackIpv4(url.hostname)) {
    throw new FirebaseAdapterError("firebase-emulator-not-local", `Firebase Auth emulator must be local, got ${url.hostname}`);
  }
  url.hash = "";
  url.search = "";
  const normalized = url.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function emulatorUrlFor(options: FirebaseAdapterOptions): string {
  const env = options.env ?? process.env;
  return normalizeEmulatorUrl(options.emulatorUrl ?? env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099");
}

function projectIdFor(options: FirebaseAdapterOptions): string {
  const env = options.env ?? process.env;
  return options.projectId ?? env.FIREBASE_PROJECT_ID ?? env.GCLOUD_PROJECT ?? "ghost-invasion-local";
}

function apiKeyFor(options: FirebaseAdapterOptions): string {
  const env = options.env ?? process.env;
  return options.apiKey ?? env.FIREBASE_WEB_API_KEY ?? env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "fake-api-key";
}

function appOrigin(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

async function requestFirebaseAuth(
  fetchImpl: typeof fetch,
  emulatorUrl: string,
  endpoint: "signUp" | "signInWithPassword",
  apiKey: string,
  body: Record<string, unknown>
): Promise<FirebaseAuthResponse> {
  const response = await fetchImpl(`${emulatorUrl}/identitytoolkit.googleapis.com/v1/accounts:${endpoint}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? JSON.stringify((parsed as { error: unknown }).error)
        : text || `HTTP ${response.status}`;
    throw new FirebaseAdapterError("firebase-auth-request-failed", message);
  }
  const result = parsed as Partial<FirebaseAuthResponse>;
  if (!result.idToken || !result.refreshToken || !result.localId) {
    throw new FirebaseAdapterError("firebase-session-missing", "Firebase Auth emulator response did not include idToken, refreshToken, and localId.");
  }
  return {
    idToken: result.idToken,
    email: result.email ?? String(body.email),
    refreshToken: result.refreshToken,
    expiresIn: result.expiresIn ?? "3600",
    localId: result.localId
  };
}

function storageKey(apiKey: string, appName: string): string {
  return `firebase:authUser:${apiKey}:${appName}`;
}

async function writeStorageState(input: {
  path: string;
  origin: string;
  key: string;
  projectId: string;
  apiKey: string;
  appName: string;
  session: FirebaseAuthResponse;
}): Promise<void> {
  const expiresInSeconds = Number.parseInt(input.session.expiresIn, 10);
  const expirationTime = Date.now() + (Number.isFinite(expiresInSeconds) ? expiresInSeconds : 3600) * 1000;
  const firebaseUser = {
    uid: input.session.localId,
    email: input.session.email,
    emailVerified: false,
    isAnonymous: false,
    providerData: [{ providerId: "password", uid: input.session.email, displayName: null, email: input.session.email, phoneNumber: null, photoURL: null }],
    stsTokenManager: {
      refreshToken: input.session.refreshToken,
      accessToken: input.session.idToken,
      expirationTime
    },
    createdAt: String(Date.now()),
    lastLoginAt: String(Date.now()),
    apiKey: input.apiKey,
    appName: input.appName
  };

  await mkdir(dirname(input.path), { recursive: true });
  await writeFile(
    input.path,
    `${JSON.stringify(
      {
        cookies: [],
        origins: [
          {
            origin: input.origin,
            localStorage: [
              { name: input.key, value: JSON.stringify(firebaseUser) },
              { name: "firebase:emulator:authUser", value: JSON.stringify({ projectId: input.projectId, appName: input.appName }) }
            ]
          }
        ]
      },
      null,
      2
    )}\n`
  );
}

export class FirebaseAuthAdapter {
  readonly id = "firebase" as const;

  constructor(private readonly options: FirebaseAdapterOptions = {}) {}

  async mintSession(input: MintFirebaseSessionInput): Promise<MintedFirebaseSession> {
    const emulatorUrl = emulatorUrlFor(this.options);
    const projectId = projectIdFor(this.options);
    const apiKey = apiKeyFor(this.options);
    const appName = this.options.appName ?? "[DEFAULT]";
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const body = { email: input.email, password: input.password, returnSecureToken: true };

    let session: FirebaseAuthResponse;
    try {
      session = await requestFirebaseAuth(fetchImpl, emulatorUrl, "signUp", apiKey, body);
    } catch (error) {
      const message = error instanceof FirebaseAdapterError ? error.message : String(error);
      if (!message.includes("EMAIL_EXISTS")) throw error;
      session = await requestFirebaseAuth(fetchImpl, emulatorUrl, "signInWithPassword", apiKey, body);
    }

    const origin = appOrigin(input.appBaseUrl);
    const key = storageKey(apiKey, appName);
    await writeStorageState({
      path: input.storageStatePath,
      origin,
      key,
      projectId,
      apiKey,
      appName,
      session
    });

    return {
      role: input.role,
      email: session.email,
      uid: session.localId,
      storageStatePath: input.storageStatePath,
      storageKey: key,
      appOrigin: origin,
      emulatorUrl
    };
  }
}
