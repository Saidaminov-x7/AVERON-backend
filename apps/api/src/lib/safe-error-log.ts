/** Returns operational error metadata without serializing messages, stacks, or query parameters. */
export function safeErrorLogFields(error: unknown): { errorType: string; errorCode?: string } {
  if (!(error instanceof Error)) return { errorType: 'UnknownError' };
  const code = (error as Error & { code?: unknown }).code;
  return {
    errorType: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : 'Error',
    ...(typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? { errorCode: code } : {}),
  };
}
