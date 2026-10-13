import { ApiError, basePath } from './api';

/** Reads a newline JSON response, calling `onEvent` for every parsed line. */
export async function streamJson<T>(path: string, onEvent: (event: T) => void, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${basePath}/api${path}`, { signal, headers: { Accept: 'application/x-ndjson' } });
  if (!response.ok || !response.body) {
    let message = response.statusText;
    try {
      message = ((await response.json()) as { error?: string }).error ?? message;
    } catch {
      // keep the status text
    }
    throw new ApiError(response.status, message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent(JSON.parse(line) as T);
    }
  }
}
