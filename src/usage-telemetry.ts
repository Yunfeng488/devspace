export interface UsageTelemetryObservation {
  attributes: {
    "mcp.method.name": "tools/call";
    "gen_ai.operation.name": "execute_tool";
    "gen_ai.tool.name": string;
    "mcp.server.operation.duration": number;
    "devspace.usage.token_coverage": string;
    "error.type"?: "tool_error";
  };
  traceContext?: {
    traceparent: string;
    tracestate?: string;
  };
}

export interface UsageTelemetrySink {
  emit(observation: UsageTelemetryObservation): void;
}

export function safeTraceContext(meta: Record<string, unknown> | undefined) {
  const traceparent = typeof meta?.traceparent === "string" ? meta.traceparent : undefined;
  if (!traceparent || !/^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/i.test(traceparent)) {
    return undefined;
  }
  const tracestate = typeof meta?.tracestate === "string" && meta.tracestate.length <= 512
    ? meta.tracestate
    : undefined;
  return { traceparent, ...(tracestate ? { tracestate } : {}) };
}
