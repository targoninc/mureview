export interface ParsedRepoList {
  repos: string[];
  invalid: string[];
}

export function normalizeRepo(input: string): string | null {
  let value = input.trim();
  if (!value) return null;
  value = value
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(value)) return null;
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
