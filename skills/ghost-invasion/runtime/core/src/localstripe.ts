import http from "node:http";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface LocalStripeSession {
  id: string;
  object: "checkout.session";
  amount_total: number;
  currency: string;
  payment_status: "unpaid" | "paid";
  status: "open" | "complete";
  url: string;
}

export interface LocalStripePaymentIntent {
  id: string;
  object: "payment_intent";
  amount: number;
  currency: string;
  status: "requires_confirmation" | "succeeded";
}

export interface LocalStripeRequestLog {
  method: string;
  path: string;
  status: number;
}

export interface LocalStripeState {
  sessions: LocalStripeSession[];
  paymentIntents: LocalStripePaymentIntent[];
  requests: LocalStripeRequestLog[];
}

export interface LocalStripeServer {
  baseUrl: string;
  state(): LocalStripeState;
  stop(): Promise<void>;
  writeState(runRoot: string): Promise<string>;
}

export async function startLocalStripe(): Promise<LocalStripeServer> {
  const sessions = new Map<string, LocalStripeSession>();
  const paymentIntents = new Map<string, LocalStripePaymentIntent>();
  const requests: LocalStripeRequestLog[] = [];
  let sessionSequence = 0;
  let intentSequence = 0;
  let baseUrl = "";
  const state = (): LocalStripeState => ({
    sessions: [...sessions.values()],
    paymentIntents: [...paymentIntents.values()],
    requests: [...requests]
  });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";

    const send = (status: number, payload: unknown) => {
      requests.push({ method, path: url.pathname, status });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };

    try {
      if (method === "GET" && url.pathname === "/health") {
        send(200, { ok: true, provider: "localstripe" });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/checkout/sessions") {
        const body = await readJsonBody(request);
        sessionSequence += 1;
        const id = `cs_test_${String(sessionSequence).padStart(6, "0")}`;
        const amount = moneyAmount(body.amount_total ?? body.amount ?? body.total, 2_000);
        const session: LocalStripeSession = {
          id,
          object: "checkout.session",
          amount_total: amount,
          currency: String(body.currency ?? "usd"),
          payment_status: "unpaid",
          status: "open",
          url: `${baseUrl}/checkout/${id}`
        };
        sessions.set(id, session);
        send(200, session);
        return;
      }

      const sessionMatch = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
      if (method === "GET" && sessionMatch) {
        const session = sessions.get(sessionMatch[1]!);
        send(session ? 200 : 404, session ?? { error: { message: "No such checkout.session" } });
        return;
      }

      const completeMatch = /^\/v1\/checkout\/sessions\/([^/]+)\/complete$/.exec(url.pathname);
      if (method === "POST" && completeMatch) {
        const session = sessions.get(completeMatch[1]!);
        if (!session) {
          send(404, { error: { message: "No such checkout.session" } });
          return;
        }
        const paid: LocalStripeSession = { ...session, payment_status: "paid", status: "complete" };
        sessions.set(paid.id, paid);
        send(200, paid);
        return;
      }

      if (method === "POST" && url.pathname === "/v1/payment_intents") {
        const body = await readJsonBody(request);
        intentSequence += 1;
        const id = `pi_test_${String(intentSequence).padStart(6, "0")}`;
        const intent: LocalStripePaymentIntent = {
          id,
          object: "payment_intent",
          amount: moneyAmount(body.amount, 2_000),
          currency: String(body.currency ?? "usd"),
          status: "requires_confirmation"
        };
        paymentIntents.set(id, intent);
        send(200, intent);
        return;
      }

      const confirmMatch = /^\/v1\/payment_intents\/([^/]+)\/confirm$/.exec(url.pathname);
      if (method === "POST" && confirmMatch) {
        const intent = paymentIntents.get(confirmMatch[1]!);
        if (!intent) {
          send(404, { error: { message: "No such payment_intent" } });
          return;
        }
        const succeeded: LocalStripePaymentIntent = { ...intent, status: "succeeded" };
        paymentIntents.set(succeeded.id, succeeded);
        send(200, succeeded);
        return;
      }

      send(404, { error: { message: "Unhandled localstripe endpoint" } });
    } catch (error) {
      send(500, { error: { message: error instanceof Error ? error.message : String(error) } });
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("localstripe failed to bind a loopback port.");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    state,
    async stop() {
      if (!server.listening) return;
      server.close();
      await once(server, "close");
    },
    async writeState(runRoot: string) {
      const path = join(runRoot, "localstripe-state.json");
      await writeFile(path, `${JSON.stringify(state(), null, 2)}\n`, "utf8");
      return path;
    }
  };
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

function moneyAmount(input: unknown, fallback: number): number {
  const parsed = typeof input === "number" ? input : Number.parseInt(String(input ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
