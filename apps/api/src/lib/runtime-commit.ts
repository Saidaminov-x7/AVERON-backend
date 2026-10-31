const fullGitShaPattern = /^[0-9a-f]{40}$/i;

export function getRuntimeCommitSha(value: string | undefined): string | null {
  const sha = value?.trim();
  return sha && fullGitShaPattern.test(sha) ? sha.toLowerCase() : null;
}
