export const ERROR_PROFILES = {
  timeout: { label: "Timeout", message: "The simulated tool timed out waiting for an upstream response.", retryable: true },
  rate_limit: { label: "Rate limit", message: "The simulated tool exceeded its upstream request rate limit.", retryable: true },
  connection: { label: "Connection error", message: "The simulated tool could not connect to its upstream service.", retryable: true },
  invalid_arguments: { label: "Invalid arguments", message: "The simulated service rejected the tool arguments as invalid.", retryable: false },
  permission_denied: { label: "Permission denied", message: "The simulated service denied access to the requested resource.", retryable: false },
  unavailable: { label: "Tool unavailable", message: "The simulated service reported that the requested tool is unavailable.", retryable: true },
  tool_error: { label: "Tool error", message: "The simulated tool reported an execution error.", retryable: true },
} as const;

export type ErrorProfile = keyof typeof ERROR_PROFILES;

export function parseErrorProfile(value: unknown): ErrorProfile | undefined {
  if (typeof value === "string" && Object.hasOwn(ERROR_PROFILES, value)) return value as ErrorProfile;
}
