import { createHash } from "node:crypto";
import { checkBotId } from "botid/server";
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

const PUBLIC_MAX_OUTPUT_TOKENS = 512;
const RUN_WINDOW_MS = 10 * 60 * 1000;
const INSTANCE_RUN_WINDOW_MS = 60 * 60 * 1000;
const MAX_RUNS_PER_IP_PER_WINDOW = 3;
const MAX_RUNS_PER_INSTANCE_PER_HOUR = 20;
const MAX_CONCURRENT_RUNS_PER_INSTANCE = 2;
const runWindows = new Map<string, { startedAt: number; count: number }>();
const instanceRunTimes: number[] = [];
let activeRuns = 0;

function jsonError(message: string, status: number, extraHeaders: Record<string, string> = {}) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store", ...extraHeaders } });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function readLimitedBody(request: Request, maximumBytes: number) {
  if (!request.body) return { body: "", tooLarge: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        return { body: "", tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: new TextDecoder().decode(bytes), tooLarge: false };
}

function consumeRunWindow(request: Request) {
  const now = Date.now();
  while (instanceRunTimes.length && now - instanceRunTimes[0] >= INSTANCE_RUN_WINDOW_MS) instanceRunTimes.shift();
  if (instanceRunTimes.length >= MAX_RUNS_PER_INSTANCE_PER_HOUR) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((INSTANCE_RUN_WINDOW_MS - (now - instanceRunTimes[0])) / 1000)) };
  }

  const address = request.headers.get("x-vercel-forwarded-for") ?? request.headers.get("x-forwarded-for");
  const ip = address?.split(",", 1)[0]?.trim();
  if (!ip) return { allowed: false, retryAfterSeconds: 600 };

  const key = createHash("sha256").update(ip).digest("hex");
  const current = runWindows.get(key);
  if (!current || now - current.startedAt >= RUN_WINDOW_MS) {
    if (runWindows.size >= 5000) {
      for (const [entryKey, entry] of runWindows) {
        if (now - entry.startedAt >= RUN_WINDOW_MS) runWindows.delete(entryKey);
      }
      while (runWindows.size >= 5000) runWindows.delete(runWindows.keys().next().value!);
    }
    runWindows.set(key, { startedAt: now, count: 1 });
    instanceRunTimes.push(now);
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (current.count >= MAX_RUNS_PER_IP_PER_WINDOW) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((RUN_WINDOW_MS - (now - current.startedAt)) / 1000)) };
  }

  current.count += 1;
  instanceRunTimes.push(now);
  if (runWindows.size > 5000) {
    for (const [entryKey, entry] of runWindows) {
      if (now - entry.startedAt >= RUN_WINDOW_MS) runWindows.delete(entryKey);
    }
    while (runWindows.size > 5000) runWindows.delete(runWindows.keys().next().value!);
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

function ndjsonStream(request: RunRequest, releaseRun: () => void) {
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  const runSignal = AbortSignal.any([abortController.signal, AbortSignal.timeout(45_000)]);
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

      void executeRun({ ...request, signal: runSignal }, onEvent, connectInMemoryTicketMcp)
        .then((run) => write({ type: "complete", run }))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "The simulated run could not be completed.";
          write({ type: "error", error: message });
        })
        .finally(() => {
          close();
          releaseRun();
        });
    },
    cancel(reason) {
      abortController.abort(reason);
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

    const isHostedDeployment = process.env.VERCEL_ENV === "production" || process.env.VERCEL_ENV === "preview";
    const origin = request.headers.get("origin");
    if (isHostedDeployment && !origin) {
      return jsonError("A same-origin browser request is required to start a hosted run.", 403);
    }
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
      const { body, tooLarge } = await readLimitedBody(request, 16 * 1024);
      if (tooLarge) return jsonError("Request body is too large.", 413);
      payload = asRecord(JSON.parse(body));
    } catch {
      return jsonError("Request body must be valid JSON.", 400);
    }
    if (!payload) return jsonError("Request body must be a JSON object.", 400);

    const mode: RunMode = payload.mode === "hanzo" ? "hanzo" : "scripted";
    if (isHostedDeployment && mode !== "hanzo") {
      return jsonError("Hosted runs require Hanzo mode. Scripted runs are available only in local development.", 403);
    }
    if (mode === "hanzo") {
      if (!process.env.HANZO_API_KEY?.trim()) {
        return jsonError("Hanzo mode is unavailable because HANZO_API_KEY is not configured on this deployment.", 503);
      }
      if (payload.confirmed !== true) {
        return jsonError("Confirm the Hanzo run before starting it.", 403);
      }
    }

    if (isHostedDeployment) {
      try {
        const verification = await checkBotId({
          advancedOptions: {
            checkLevel: "basic",
            headers: Object.fromEntries(request.headers.entries()),
          },
        });
        if (verification.isBot) return jsonError("Automated requests are blocked on this public demo.", 403);
      } catch {
        return jsonError("The public-run protection check is unavailable. Please try again shortly.", 503);
      }

      if (activeRuns >= MAX_CONCURRENT_RUNS_PER_INSTANCE) {
        return jsonError("The demo is busy. Please try again shortly.", 429, { "Retry-After": "30" });
      }
      const runWindow = consumeRunWindow(request);
      if (!runWindow.allowed) {
        return jsonError("Run limit reached. Please wait before starting another scenario.", 429, {
          "Retry-After": String(runWindow.retryAfterSeconds),
        });
      }
    }

    const configuredTokens = typeof payload.maxOutputTokens === "number" && Number.isFinite(payload.maxOutputTokens)
      ? Math.floor(payload.maxOutputTokens)
      : 2048;
    const runRequest: RunRequest = {
      mode,
      fault: parseFault(payload.fault),
      model: isHostedDeployment
        ? process.env.VERCEL_ENV === "preview" ? "google/gemini-2.5-flash-lite" : process.env.HANZO_MODEL_ID?.trim() || "enso-auto"
        : typeof payload.model === "string" ? payload.model.trim().slice(0, 120) : process.env.HANZO_MODEL_ID?.trim() || "enso-auto",
      maxOutputTokens: isHostedDeployment
        ? PUBLIC_MAX_OUTPUT_TOKENS
        : Math.max(256, Math.min(8192, configuredTokens)),
      confirmed: mode === "hanzo" && payload.confirmed === true,
    };

    if (isHostedDeployment) activeRuns += 1;
    let released = false;
    const releaseRun = () => {
      if (released || !isHostedDeployment) return;
      released = true;
      activeRuns = Math.max(0, activeRuns - 1);
    };
    return new Response(ndjsonStream(runRequest, releaseRun), { headers: streamHeaders });
  },
};
