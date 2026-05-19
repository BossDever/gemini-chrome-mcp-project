import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const DEFAULT_BLOCKED_EXTENSIONS = new Set([
  ".bat",
  ".cmd",
  ".com",
  ".cpl",
  ".dll",
  ".exe",
  ".hta",
  ".js",
  ".jse",
  ".lnk",
  ".msi",
  ".ps1",
  ".scr",
  ".vbs",
  ".wsf",
]);

function parseBytes(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseExtensionSet(value, fallback) {
  if (!value) return fallback;
  return new Set(String(value)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => entry.startsWith(".") ? entry : `.${entry}`));
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function verifyLocalUploadFile(filePath, {
  maxBytes = parseBytes(process.env.GEMINI_MCP_UPLOAD_MAX_BYTES, DEFAULT_MAX_UPLOAD_BYTES),
  blockedExtensions = parseExtensionSet(process.env.GEMINI_MCP_UPLOAD_BLOCKED_EXTENSIONS, DEFAULT_BLOCKED_EXTENSIONS),
  allowUnsafe = process.env.GEMINI_MCP_ALLOW_UNSAFE_UPLOAD === "1",
} = {}) {
  const fileInfo = await stat(filePath);
  if (!fileInfo.isFile()) {
    return { ok: false, errorCode: "UPLOAD_PATH_NOT_FILE", sizeBytes: fileInfo.size };
  }

  const extension = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  const blocked = blockedExtensions.has(extension);
  const tooLarge = fileInfo.size > maxBytes;
  const warnings = [];
  if (blocked) warnings.push("UPLOAD_EXTENSION_BLOCKED");
  if (tooLarge) warnings.push("UPLOAD_FILE_TOO_LARGE");

  if (!allowUnsafe && tooLarge) {
    return { ok: false, errorCode: "UPLOAD_FILE_TOO_LARGE", name, extension, sizeBytes: fileInfo.size, maxBytes, sha256: null, warnings };
  }

  const sha256 = await sha256File(filePath);
  if (!allowUnsafe && blocked) {
    return { ok: false, errorCode: "UPLOAD_EXTENSION_BLOCKED", name, extension, sizeBytes: fileInfo.size, maxBytes, sha256, warnings };
  }

  return {
    ok: true,
    safeForUpload: warnings.length === 0,
    name,
    extension,
    sizeBytes: fileInfo.size,
    maxBytes,
    sha256,
    warnings,
  };
}
