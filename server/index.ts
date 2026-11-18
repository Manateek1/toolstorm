import dotenv from "dotenv";
import express, { type Request, type Response, type NextFunction } from "express";
import { executeRun } from "./agent.ts";
import { parseFault } from "../src/domain/fixture.ts";
import type { RunMode, RunRequest } from "../src/domain/types.ts";

dotenv.config({ path: ".env.local" });

const app = express();
const portValue = Number(process.env.PORT ?? 4177);
const port = Number.isInteger(portValue) && portValue > 0 && portValue <= 65535 ? portValue : 4177;
const expectedHost = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const allowedOrigins = new Set(["http://127.0.0.1:5173", "http://localhost:5173"]);

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb", strict: true }));

app.use((req: Request, res: Response, next: NextFunction) => {
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (host && !expectedHost.has(host)) return res.status(403).json({ error: "Local-only API." });
  if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ error: "Local-only API." });
  next();
});

app.get("/api/status", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    available: true,
    source: "local",
    hasHanzoKey: Boolean(process.env.HANZO_API_KEY?.trim()),
    defaultModel: process.env.HANZO_MODEL_ID?.trim() || "enso-auto",
  });
});

app.post("/api/run", async (req, res) => {
  const value = req.body as Partial<RunRequest> | undefined;
  const mode: RunMode = value?.mode === "hanzo" ? "hanzo" : "scripted";
  if (mode === "hanzo" && value?.confirmed !== true) {
    return res.status(400).json({ error: "Confirm the credit disclosure before starting a Hanzo run." });
  }
  if (mode === "hanzo" && !process.env.HANZO_API_KEY?.trim()) {
    return res.status(503).json({ error: "HANZO_API_KEY is not set. Scripted MCP demo mode is available without a key." });
  }

  const request: RunRequest = {
    mode,
    fault: parseFault(value?.fault),
    model: typeof value?.model === "string" ? value.model.slice(0, 120) : "enso-auto",
    maxOutputTokens: typeof value?.maxOutputTokens === "number" ? value.maxOutputTokens : 2048,
    confirmed: value?.confirmed === true,
  };

  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.flushHeaders();

    const write = (message: unknown) => {
      if (!res.destroyed) res.write(`${JSON.stringify(message)}\n`);
    };
    const run = await executeRun(request, (event) => write({ type: "event", event }));
    write({ type: "complete", run });
    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : "The local run could not be completed.";
    if (res.headersSent) {
      if (!res.destroyed) {
        res.write(`${JSON.stringify({ type: "error", error: message })}\n`);
        res.end();
      }
    } else {
      res.status(500).json({ error: message });
    }
  }
});

app.listen(port, "127.0.0.1", () => {
  console.info(`Toolstorm local API is listening on http://127.0.0.1:${port}`);
});
