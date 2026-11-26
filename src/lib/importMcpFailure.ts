import type { ErrorProfile } from "../domain/errorProfiles.ts";

export const MAX_FAILURE_IMPORT_BYTES = 128 * 1024;
const MAX_FAILURES = 50;

export interface ImportedFailure {
  source: "MCP tool result" | "JSON-RPC error" | "Toolstorm trace" | "Error log";
  message: string;
  code?: string;
  tool?: string;
  profile: ErrorProfile;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function asText(value: unknown, maxLength: number) {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, maxLength);
}

function textContent(value: unknown) {
  if (!Array.isArray(value)) return;
  return asText(value.flatMap((item) => {
    const block = asObject(item);
    return block?.type === "text" ? asText(block.text, 600) ?? [] : [];
  }).join("\n"), 600);
}

function classify(message: string, code?: string): ErrorProfile {
  if (code === "429" || /\b(?:429|rate.?limit(?:ed|ing)?|too many requests)\b/i.test(message)) return "rate_limit";
  if (code === "401" || code === "403" || /\b(?:401|403|permission denied|forbidden|unauthori[sz]ed|access denied|authentication failed)\b/i.test(message)) return "permission_denied";
  if (code === "-32602" || /\b(?:invalid (?:params|parameters|arguments|input)|validation failed)\b/i.test(message)) return "invalid_arguments";
  if (/\b(?:timeout|timed out|deadline exceeded|etimedout)\b/i.test(message)) return "timeout";
  if (code === "-32601" || code === "503" || /\b(?:503|unavailable|unknown tool|tool not found|method not found)\b/i.test(message)) return "unavailable";
  if (/\b(?:econnrefused|econnreset|network error|connection (?:error|reset|refused|closed)|transport (?:failed|closed))\b/i.test(message)) return "connection";
  return "tool_error";
}

function failure(source: ImportedFailure["source"], message: string, tool?: string, code?: unknown): ImportedFailure {
  const codeText = typeof code === "number" ? String(code) : asText(code, 32);
  return { source, message, tool, code: codeText, profile: classify(message, codeText) };
}

function readFailure(value: unknown, toolsById: Map<string | number, string>): ImportedFailure | undefined {
  const entry = asObject(value);
  if (!entry) return;
  const response = asObject(entry.response) ?? entry;
  const result = asObject(response.result) ?? response;
  const id = response.id;
  const requestTool = typeof id === "string" || typeof id === "number" ? toolsById.get(id) : undefined;
  const tool = asText(entry.toolName ?? entry.tool ?? result.toolName, 100) ?? requestTool;
  if (result.isError === true || result.is_error === true) {
    const message = textContent(result.content) ?? asText(result.message, 600) ?? "The MCP tool marked its result as an error.";
    return failure("MCP tool result", message, tool, result.code);
  }

  const rpcError = asObject(response.error);
  if (rpcError || (response.code !== undefined && typeof response.message === "string")) {
    const error = rpcError ?? response;
    const message = asText(error.message, 600) ?? "The server returned an error.";
    return failure(response.jsonrpc === "2.0" || error.code !== undefined ? "JSON-RPC error" : "Error log", message, tool, error.code);
  }

  if (entry.kind === "tool" && entry.status === "error") {
    const message = asText(entry.detail, 600) ?? asText(entry.title, 600) ?? "The recorded tool call failed.";
    return failure("Toolstorm trace", message, tool);
  }
  const message = asText(response.error, 600);
  if (message) return failure("Error log", message, tool, response.code);
}

export function parseMcpFailureImport(input: string): ImportedFailure[] {
  if (new TextEncoder().encode(input).length > MAX_FAILURE_IMPORT_BYTES) {
    throw new Error("Choose a file or paste an excerpt under 128 KB.");
  }

  const text = input.trim();
  if (!text) throw new Error("Paste a failure or choose a log file.");

  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    if (text.startsWith("{") || /^\[\s*(?:\{|\[|"|\])/.test(text)) {
      try {
        decoded = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown);
      } catch {
        throw new Error("This looks like incomplete JSON. Paste a complete JSON response or a JSONL log.");
      }
    } else {
      return [failure("Error log", text.slice(0, 600))];
    }
  }

  const envelope = asObject(decoded);
  const rows = envelope && Array.isArray(envelope.trace) ? envelope.trace
    : envelope && Array.isArray(envelope.messages) ? envelope.messages
    : Array.isArray(decoded) ? decoded
    : [decoded];

  const toolsById = new Map<string | number, string>();
  const failures: ImportedFailure[] = [];
  for (const row of rows) {
    const request = asObject(row);
    if (request?.method === "tools/call") {
      const tool = asText(asObject(request.params)?.name, 100);
      if (tool && (typeof request.id === "string" || typeof request.id === "number")) toolsById.set(request.id, tool);
      continue;
    }
    const entry = readFailure(row, toolsById);
    if (entry) failures.push(entry);
    if (failures.length === MAX_FAILURES) break;
  }
  if (!failures.length) throw new Error("No failure found. Use an MCP error response, a failed tool result, or an error log.");
  return failures;
}
