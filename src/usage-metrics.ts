export type TokenCoverageStatus = "FULL" | "PARTIAL_UNSUPPORTED_MEDIA";
export type MeasurementFailureStatus = "MEASUREMENT_ERROR" | "MEASUREMENT_UNSUPPORTED";

export interface PayloadMeasurement {
  canonical: string;
  tokenText: string;
  bytes: number;
  characters: number;
  tokenStatus: TokenCoverageStatus;
}

export function measureRequestPayload(input: unknown): PayloadMeasurement {
  const canonical = stableJson(input);
  return measurement(canonical, canonical, "FULL");
}

export function measureResponsePayload(result: unknown): PayloadMeasurement {
  const record = asRecord(result);
  const visible: Record<string, unknown> = {};

  if (record && Object.hasOwn(record, "content")) {
    visible.content = record.content;
  }

  if (record && Object.hasOwn(record, "structuredContent")) {
    visible.structuredContent = record.structuredContent;
  }

  const canonical = stableResponseJson(visible);
  const classified = classifyForTokens(JSON.parse(canonical) as unknown);
  return measurement(
    canonical,
    stableJson(classified.value),
    classified.partial ? "PARTIAL_UNSUPPORTED_MEDIA" : "FULL",
  );
}

export function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalized = normalize(value, seen, false);
  return JSON.stringify(normalized) ?? "null";
}

function stableResponseJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalized = normalize(value, seen, true);
  return JSON.stringify(normalized) ?? "null";
}

function measurement(
  canonical: string,
  tokenText: string,
  tokenStatus: TokenCoverageStatus,
): PayloadMeasurement {
  return {
    canonical,
    tokenText,
    bytes: Buffer.byteLength(canonical, "utf8"),
    characters: Array.from(canonical).length,
    tokenStatus,
  };
}

function normalize(value: unknown, seen: WeakSet<object>, excludeMeta: boolean): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw unsupported("Non-finite numbers are not JSON data");
    return value;
  }
  if (typeof value !== "object") throw unsupported("Payload contains non-JSON data");
  if (seen.has(value)) throw new TypeError("Cannot measure a circular payload");
  seen.add(value);

  try {
    if (Array.isArray(value)) return value.map((entry) => normalize(entry, seen, excludeMeta));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw unsupported("Payload contains a non-plain object");
    }

    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (excludeMeta && key === "_meta") continue;
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) result[key] = normalize(entry, seen, excludeMeta);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function measurementFailureStatus(error: unknown): MeasurementFailureStatus {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "MEASUREMENT_UNSUPPORTED"
    ? "MEASUREMENT_UNSUPPORTED"
    : "MEASUREMENT_ERROR";
}

function unsupported(message: string): Error {
  return Object.assign(new TypeError(message), { code: "MEASUREMENT_UNSUPPORTED" });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function classifyForTokens(value: unknown, contentItem = false): { value: unknown; partial: boolean } {
  if (value === null || typeof value !== "object") return { value, partial: false };
  if (Array.isArray(value)) {
    const classified = value.map((entry) => classifyForTokens(entry, contentItem));
    return {
      value: classified.map((entry) => entry.value),
      partial: classified.some((entry) => entry.partial),
    };
  }

  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const mimeType = typeof record.mimeType === "string" ? record.mimeType.toLowerCase() : "";
  const explicitlyBinary = type === "image"
    || type === "audio"
    || Object.hasOwn(record, "blob")
    || (Object.hasOwn(record, "data") && (
      mimeType.startsWith("image/")
      || mimeType.startsWith("audio/")
      || mimeType === "application/octet-stream"
    ));
  const unsupportedContent = contentItem
    && type !== ""
    && !["text", "resource", "resource_link"].includes(type);
  let partial = explicitlyBinary || unsupportedContent;
  const output: Record<string, unknown> = {};

  for (const key of Object.keys(record).sort()) {
    if ((key === "data" || key === "blob") && explicitlyBinary) continue;
    const child = classifyForTokens(record[key], key === "content");
    output[key] = child.value;
    partial ||= child.partial;
  }
  return { value: output, partial };
}
