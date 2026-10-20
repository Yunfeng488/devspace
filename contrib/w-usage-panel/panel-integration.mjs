import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createUsageRequestHandler } from "./usage-api.mjs";

export function localUsageHealthToken(usageDirectory) {
  const path = join(usageDirectory, "usage-health.token");
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0 || stat.size > 1_024) {
      return undefined;
    }
    const token = readFileSync(path, "utf8").trim();
    return /^[A-Za-z0-9_-]{43,128}$/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

const directory = fileURLToPath(new URL(".", import.meta.url));

const usageLinkMarker = "data-devspace-usage-monitor-link";
const usageLink = `<a href="/usage" ${usageLinkMarker} style="display:inline-flex;align-items:center;margin:0 0 20px;padding:7px 11px;border:1px solid #30363d;border-radius:8px;color:#4493f8;text-decoration:none">用量监控</a>`;

/** Add one self-contained navigation entry while preserving the panel document. */
export function addUsageMonitorLink(html) {
  if (typeof html !== "string" || html.includes(usageLinkMarker)) return html;
  if (/<\/h1>/i.test(html)) return html.replace(/<\/h1>/i, (match) => `${match}\n  ${usageLink}`);
  if (/<\/header>/i.test(html)) return html.replace(/<\/header>/i, (match) => `${usageLink}${match}`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (match) => `${match}\n${usageLink}`);
  return `${usageLink}\n${html}`;
}

/**
 * Create the GET-only endpoint handler to call before an existing panel's
 * generic 404 handler. It owns only /usage and /api/usage/*.
 */
export function createWUsagePanelIntegration({
  usageDirectory,
  devspaceHealthUrl = "http://127.0.0.1:7676/usage-healthz",
  devspaceAccessToken,
  runtimeHealthProvider,
}) {
  const provider = runtimeHealthProvider
    ?? (devspaceHealthUrl ? () => fetchUsageRuntimeHealth({
      url: devspaceHealthUrl,
      accessToken: devspaceAccessToken ?? localUsageHealthToken(usageDirectory),
    }) : undefined);
  return createUsageRequestHandler({
    databasePath: join(usageDirectory, "usage.sqlite"),
    pagePath: join(directory, "usage.html"),
    runtimeHealthProvider: provider,
  });
}

export async function fetchUsageRuntimeHealth({
  url = "http://127.0.0.1:7676/usage-healthz",
  fetchImpl = fetch,
  timeoutMs = 1_000,
  accessToken,
} = {}) {
  if (!accessToken) return { writer_state: "UNKNOWN" };
  try {
    const response = await fetchImpl(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return { writer_state: "OFFLINE" };
    const body = await response.json();
    return body && typeof body.usage === "object" && body.usage !== null
      ? body.usage
      : { writer_state: "UNKNOWN" };
  } catch {
    return { writer_state: "OFFLINE" };
  }
}
