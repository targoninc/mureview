export interface ParsedRepoList {
  repos: string[];
  invalid: string[];
}

export function normalizeRepo(input: string): string | null {
  let value = input.trim();
  if (!value) return null;
  // Strip a leading host only when something remains after it: handles look
  // like hosts too (alice.bsky.social/repo).
  const withoutHost = value.replace(/^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i, '');
  if (withoutHost !== value && withoutHost.includes('/')) value = withoutHost;
  value = value.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  if (value.startsWith('@')) value = value.slice(1);
  if (!/^[\w.:-]+\/[\w.-]+$/.test(value)) return null;
  return value;
}

export function parseRepoList(inputs: string[]): ParsedRepoList {
  const repos: string[] = [];
  const invalid: string[] = [];
  for (const raw of inputs) {
    if (!raw.trim()) continue;
    const normalized = normalizeRepo(raw);
    if (!normalized) invalid.push(raw.trim());
    else if (!repos.includes(normalized)) repos.push(normalized);
  }
  return { repos, invalid };
}
