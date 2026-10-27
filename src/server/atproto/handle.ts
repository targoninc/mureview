import { resolveTxt } from 'node:dns/promises';

/** TXT records for a handle, or null when the name has no TXT records. */
export async function resolveHandleTxt(hostname: string): Promise<string[] | null> {
  try {
    const records = await resolveTxt(hostname);
    return records.map((chunks) => chunks.join(''));
  } catch (error) {
    if ((error as { code?: string }).code === 'EBADNAME') throw error;
    return null;
  }
}
