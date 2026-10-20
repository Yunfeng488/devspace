import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const IDENTITY_KEY_FILE = "identity.key";
const HEALTH_TOKEN_FILE = "usage-health.token";

export function pseudonymizeSession(
  session: string | undefined,
  identityKey: Buffer,
): string {
  if (!session) return "UNATTRIBUTED";
  const digest = createHmac("sha256", identityKey).update(session, "utf8").digest("hex");
  return `w_${digest.slice(0, 32)}`;
}

export function loadOrCreateIdentityKey(directory: string, supplied?: Buffer): Buffer {
  const path = join(directory, IDENTITY_KEY_FILE);
  const existing = readRegularFile(path);
  if (existing) {
    if (existing.byteLength === 0 || existing.byteLength > 1_024) {
      throw new Error("Usage identity key has an invalid size");
    }
    return existing;
  }

  const key = supplied ?? randomBytes(32);
  writeFileSync(path, key, { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

export function loadOrCreateUsageHealthToken(directory: string): string {
  const path = join(directory, HEALTH_TOKEN_FILE);
  const existing = readRegularFile(path);
  if (existing) return validateHealthToken(existing.toString("utf8"));

  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, token, { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

export function readUsageHealthToken(directory: string): string | null {
  const path = join(directory, HEALTH_TOKEN_FILE);
  const existing = readRegularFile(path);
  if (!existing) return null;
  try {
    return validateHealthToken(existing.toString("utf8"));
  } catch {
    return null;
  }
}

function validateHealthToken(value: string): string {
  const token = value.trim();
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) {
    throw new Error("Usage health token is invalid");
  }
  return token;
}

function readRegularFile(path: string): Buffer | undefined {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Expected a regular file: ${path}`);
  }
  return readFileSync(path);
}
