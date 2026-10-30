declare module 'gltf-validator' {
  export type ValidationIssue = { code: string; message: string; severity: number };
  export type ValidationResult = {
    issues: { numErrors: number; numWarnings: number; numInfos: number; numHints: number; messages: ValidationIssue[] };
  };
  export function validateBytes(data: Uint8Array, options?: { format?: 'glb' | 'gltf'; maxIssues?: number }): Promise<ValidationResult>;
}
