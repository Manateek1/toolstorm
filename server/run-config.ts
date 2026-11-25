import { DEFAULT_HANZO_MODEL, PREVIEW_HANZO_MODEL } from "../src/domain/runLimits.ts";

// Preview deployments use Flash for development. Production may pin a model
// through the existing environment variable.
export function configuredHanzoModel() {
  if (process.env.VERCEL_ENV === "preview") return PREVIEW_HANZO_MODEL;
  return process.env.HANZO_MODEL_ID?.trim() || DEFAULT_HANZO_MODEL;
}
