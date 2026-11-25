import { configuredHanzoModel } from "../server/run-config.ts";
import { PUBLIC_MAX_OUTPUT_TOKENS } from "../src/domain/runLimits.ts";

export const runtime = "nodejs";

export default {
  fetch(_request: Request) {
    return Response.json(
      {
        available: true,
        source: "vercel",
        hasHanzoKey: Boolean(process.env.HANZO_API_KEY?.trim()),
        defaultModel: configuredHanzoModel(),
        maxOutputTokens: PUBLIC_MAX_OUTPUT_TOKENS,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
};
