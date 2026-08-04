/** The package's canonical object guard. Fields stay `unknown` and must be checked. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
