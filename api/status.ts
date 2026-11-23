export const runtime = "nodejs";

export default {
  fetch(_request: Request) {
    return Response.json(
      {
        available: true,
        source: "vercel",
        hasHanzoKey: Boolean(process.env.HANZO_API_KEY?.trim()),
        defaultModel: process.env.VERCEL_ENV === "preview" ? "openai/gpt-4.1-nano" : process.env.HANZO_MODEL_ID?.trim() || "enso-auto",
        maxOutputTokens: 512,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
};
