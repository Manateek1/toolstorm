export const runtime = "nodejs";

export default {
  fetch(_request: Request) {
    return Response.json(
      {
        available: true,
        source: "vercel",
        // The public deployment is deliberately scripted-only. Keep credit-bearing
        // Hanzo inference on the owner's local server.
        hasHanzoKey: false,
        defaultModel: "enso-auto",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
};
