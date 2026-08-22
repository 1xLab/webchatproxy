import assert from "node:assert/strict";
import test from "node:test";

import { classifyAccountState } from "../lib/diagnostics.mjs";

test("chat body cannot promote a free account to a paid plan", () => {
  const account = classifyAccountState({
    profile_present: true,
    profile_aria_label: "Benjamin Rivera, open profile menu",
    login_present: false,
    body_preview: "Do I have Pro or Plus? This conversation mentions both plans.",
  });

  assert.equal(account.authenticated, true);
  assert.equal(account.plan, "free");
  assert.equal(account.subscription_active, false);
  assert.equal(account.evidence, "authenticated_without_paid_plan_marker");
});
