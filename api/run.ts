import { executeRun } from "../server/agent.ts";
import { connectInMemoryTicketMcp } from "../server/mcp/memory-client.ts";
import { parseFault } from "../src/domain/fixture.ts";
import type { RunMode, RunRequest, TraceEvent } from "../src/domain/types.ts";

export const runtime = "nodejs";

const streamHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function ndjsonStream(request: RunRequest) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (value: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // A client may disconnect while a run is streaming.
        }
      };
      const onEvent = (event: TraceEvent) => write({ type: "event", event });

      void executeRun(request, onEvent, connectInMemoryTicketMcp)
        .then((run) => write({ type: "complete", run }))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "The simulated run could not be completed.";
          write({ type: "error", error: message });
        })
        .finally(close);
    },
  });
}

export default {
  async fetch(request: Request) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "POST", "Cache-Control": "no-store" },
      });
    }

    const origin = request.headers.get("origin");
    if (origin) {
      try {
        if (new URL(origin).origin !== new URL(request.url).origin) {
          return jsonError("Cross-origin requests are not accepted.", 403);
        }
      } catch {
        return jsonError("The request origin is invalid.", 403);
      }
    }

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > 16 * 1024) return jsonError("Request body is too large.", 413);

    let payload: Record<string, unknown> | null;
    try {
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > 16 * 1024) return jsonError("Request body is too large.", 413);
      payload = asRecord(JSON.parse(body));
    } catch {
      return jsonError("Request body must be valid JSON.", 400);
    }
    if (!payload) return jsonError("Request body must be a JSON object.", 400);

    const mode: RunMode = payload.mode === "hanzo" ? "hanzo" : "scripted";
    const isHostedDeployment = process.env.VERCEL_ENV === "production" || process.env.VERCEL_ENV === "preview";
    if (isHostedDeployment && mode !== "hanzo") {
      return jsonError("Hosted runs require Hanzo mode. Scripted runs are available only in local development.", 403);
    }
    if (mode === "hanzo") {
      if (!process.env.HANZO_API_KEY) {
        return jsonError("Hanzo mode is unavailable because HANZO_API_KEY is not configured on this deployment.", 503);
      }
      if (payload.confirmed !== true) {
        return jsonError("Confirm the Hanzo run before starting it.", 403);
      }
    }

    const configuredTokens = typeof payload.maxOutputTokens === "number" && Number.isFinite(payload.maxOutputTokens)
      ? Math.floor(payload.maxOutputTokens)
      : 2048;
    const runRequest: RunRequest = {
      mode,
      fault: parseFault(payload.fault),
      model: typeof payload.model === "string" ? payload.model.trim().slice(0, 120) : "enso-auto",
      maxOutputTokens: Math.max(256, Math.min(8192, configuredTokens)),
      confirmed: mode === "hanzo" && payload.confirmed === true,
    };

    return new Response(ndjsonStream(runRequest), { headers: streamHeaders });
  },
};
