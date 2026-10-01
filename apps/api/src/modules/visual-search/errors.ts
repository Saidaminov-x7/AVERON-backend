export type VisualSearchErrorCode =
  | 'IMAGE_UNSUPPORTED'
  | 'IMAGE_INVALID'
  | 'IMAGE_EMBEDDING_PROVIDER_NOT_CONFIGURED'
  | 'VECTOR_SEARCH_STORAGE_NOT_CONFIGURED'
  | 'VISUAL_SEARCH_UNAVAILABLE'
  | 'EMBEDDING_NOT_AVAILABLE'
  | 'EMBEDDING_INVALID';

export class VisualSearchError extends Error {
  constructor(
    public readonly code: VisualSearchErrorCode,
    message = code,
  ) {
    super(message);
    this.name = 'VisualSearchError';
  }
}
