/** Convert a GitHub fetch/push remote into a credential-free browser URL. */
export function githubRepositoryUrl(remote: string): string | null {
  const match = remote.trim().match(/^(?:https?:\/\/(?:[^/@]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)
  return match ? `https://github.com/${match[1]}/${match[2]}` : null
}
