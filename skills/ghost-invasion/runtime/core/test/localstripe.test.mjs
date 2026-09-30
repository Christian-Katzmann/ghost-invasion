import assert from "node:assert/strict";
import test from "node:test";
import { startLocalStripe } from "../dist/localstripe.js";

test("localstripe keeps checkout and payment-intent state on loopback only", async () => {
  const localstripe = await startLocalStripe();
  try {
    assert.match(localstripe.baseUrl, /^http:\/\/127\.0\.0\.1:/);

    const created = await fetch(`${localstripe.baseUrl}/v1/checkout/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount_total: 4200, currency: "usd" })
    }).then((response) => response.json());
    assert.equal(created.id, "cs_test_000001");
    assert.equal(created.payment_status, "unpaid");

    const paid = await fetch(`${localstripe.baseUrl}/v1/checkout/sessions/cs_test_000001/complete`, {
      method: "POST"
    }).then((response) => response.json());
    assert.equal(paid.payment_status, "paid");

    const intent = await fetch(`${localstripe.baseUrl}/v1/payment_intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 1200, currency: "eur" })
    }).then((response) => response.json());
    assert.equal(intent.id, "pi_test_000001");
    assert.equal(intent.status, "requires_confirmation");

    const state = localstripe.state();
    assert.equal(state.sessions.length, 1);
    assert.equal(state.paymentIntents.length, 1);
    assert.equal(state.requests.length, 3);
  } finally {
    await localstripe.stop();
  }
});
