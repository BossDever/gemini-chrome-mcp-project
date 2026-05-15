import assert from "node:assert/strict";
import test from "node:test";

import {
  githubRepositoryKey,
  normalizeForTurnMatch,
  parseGithubRepositoryUrl,
  verifyOwnUserTurn,
} from "../src/cdp-client.mjs";

test("normalizeForTurnMatch collapses whitespace and normalizes text", () => {
  assert.equal(normalizeForTurnMatch("  hello\n\nGemini  "), "hello Gemini");
  assert.equal(normalizeForTurnMatch("ＡＢＣ"), "ABC");
});

test("verifyOwnUserTurn requires an advanced user turn index and matching text", () => {
  const beforeState = { lastUserTurnIndex: 2, lastUserText: "old" };
  assert.equal(verifyOwnUserTurn({
    beforeState,
    afterState: { lastUserTurnIndex: 3, lastUserText: "hello Gemini" },
    message: "hello\nGemini",
  }).ok, true);

  assert.equal(verifyOwnUserTurn({
    beforeState,
    afterState: { lastUserTurnIndex: 2, lastUserText: "hello Gemini" },
    message: "hello Gemini",
  }).ok, false);

  assert.equal(verifyOwnUserTurn({
    beforeState,
    afterState: { lastUserTurnIndex: 3, lastUserText: "different message" },
    message: "hello Gemini",
  }).ok, false);
});

test("parseGithubRepositoryUrl accepts canonical GitHub repository URLs", () => {
  assert.deepEqual(parseGithubRepositoryUrl("https://github.com/BossDever/gemini-chrome-mcp-project.git"), {
    ok: true,
    owner: "BossDever",
    repo: "gemini-chrome-mcp-project",
    key: "bossdever/gemini-chrome-mcp-project",
  });
  assert.equal(githubRepositoryKey("https://www.github.com/Owner/Repo/tree/main"), "owner/repo");
});

test("parseGithubRepositoryUrl rejects unsupported repository URLs", () => {
  assert.equal(parseGithubRepositoryUrl("https://example.com/Owner/Repo").reason, "HOST_NOT_GITHUB");
  assert.equal(parseGithubRepositoryUrl("https://github.com/Owner").reason, "OWNER_OR_REPO_MISSING");
  assert.equal(parseGithubRepositoryUrl("not a url").reason, "URL_PARSE_FAILED");
});
