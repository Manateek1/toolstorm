import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const configuredPort = Number(process.env.PORT ?? 4177);
const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
  ? configuredPort
  : 4177;
const url = `http://127.0.0.1:${port}/api/status`;
const deadline = Date.now() + 15_000;

while (Date.now() < deadline) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(500) });
    if (response.ok) {
      process.exit(0);
    }
  } catch {
    // The local API starts in parallel; retry briefly until it accepts requests.
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

console.error(`Toolstorm API did not become ready at ${url}. Check the api service output.`);
process.exit(1);
