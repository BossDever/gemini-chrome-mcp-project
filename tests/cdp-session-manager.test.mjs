import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getCdpBindingWarnings,
  isGeminiUrl,
  isStrictBlockingBindingWarning,
  normalizeSessionName,
  resolveBoundCdpTarget,
  writeBoundCdpTarget,
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

test("strict binding allows Gemini conversation URL and title drift", async () => {
  const bindingsDir = await mkdtemp(path.join(os.tmpdir(), "gemini-bindings-"));
  await writeBoundCdpTarget("default", {
    sessionName: "default",
    baseUrl: "http://127.0.0.1:9222",
    tabId: "1",
    url: "https://gemini.google.com/app",
    title: "Google Gemini",
  }, { bindingsDir });

  const resolved = await resolveBoundCdpTarget({
    strictBinding: true,
    bindingsDir,
    sessionName: "default",
    findTab: async () => ({
      id: "1",
      tabId: "1",
      url: "https://gemini.google.com/app/conversation-id",
      title: "Conversation title - Google Gemini",
    }),
  });
  assert.equal(resolved.tabId, "1");
  assert.deepEqual(resolved.bindingWarnings.map((warning) => warning.code), [
    "CDP_BINDING_URL_CHANGED",
    "CDP_BINDING_TITLE_CHANGED",
  ]);
});

test("strict binding still blocks missing or non-Gemini targets", () => {
  assert.equal(isStrictBlockingBindingWarning({ code: "CDP_BINDING_URL_CHANGED" }), false);
  assert.equal(isStrictBlockingBindingWarning({ code: "CDP_BINDING_TITLE_CHANGED" }), false);
  assert.equal(isStrictBlockingBindingWarning({ code: "CDP_BOUND_TAB_NOT_GEMINI" }), true);
  assert.equal(isStrictBlockingBindingWarning({ code: "CDP_BOUND_TAB_NOT_FOUND" }), true);
});
