/** Keep Fastify's automatic request log useful without serializing URLs, headers, IPs, or bodies. */
export function serializeSafeRequest(request: { method: string }) {
  return { method: request.method };
}
