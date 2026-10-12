/** Structured error context that deliberately excludes message and stack data. */
export function safeErrorLogFields(error: unknown): {
  errorType: string;
  errorCode?: string;
} {
  const errorType = error instanceof Error ? error.name : "UnknownError";
  const candidate = error as { code?: unknown } | null;
  const rawCode =
    candidate && typeof candidate === "object" ? candidate.code : undefined;
  const errorCode =
    typeof rawCode === "string" && /^[A-Z0-9_]{1,64}$/.test(rawCode)
      ? rawCode
      : undefined;
  return { errorType, ...(errorCode ? { errorCode } : {}) };
}
