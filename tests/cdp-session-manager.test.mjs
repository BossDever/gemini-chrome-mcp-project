import assert from "node:assert/strict";
import test from "node:test";

import {
  getCdpBindingWarnings,
  isGeminiUrl,
  normalizeSessionName,
} from "../src/cdp-session-manager.mjs";

test("session names are normalized and constrained", () => {
  assert.equal(normalizeSessionName(), "default");
  assert.equal(normalizeSessionName("agent-1"), "agent-1");
  assert.throws(() => normalizeSessionName("../bad"), /INVALID_SESSION_NAME/);
});

test("Gemini URL detection accepts Gemini only", () => {
  assert.equal(isGeminiUrl("https://gemini.google.com/app"), true);
  assert.equal(isGeminiUrl("https://chatgpt.com/"), false);
});

test("binding warnings detect non-Gemini and changed URL", async () => {
  const warnings = await getCdpBindingWarnings({
    baseUrl: "http://127.0.0.1:9222",
    binding: { tabId: "1", url: "https://gemini.google.com/app", title: "old" },
    findTab: async () => ({ id: "1", url: "https://example.com", title: "new" }),
  });
  assert.deepEqual(warnings.map((warning) => warning.code), [
    "CDP_BOUND_TAB_NOT_GEMINI",
    "CDP_BINDING_URL_CHANGED",
    "CDP_BINDING_TITLE_CHANGED",
  ]);
});
