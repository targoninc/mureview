import { useEffect, useRef } from 'react';

/** The file shape auto-marking works on. */
export interface AutoViewedFile {
  id: string;
  /** Cumulative diff entries have no marks of their own. */
  combined: boolean;
}

interface AutoViewedOptions {
  /** The user's "mark files as viewed automatically" setting. */
  enabled: boolean;
  /** The open pull request; marks only live while it is open. */
  prId: number | null;
  fileMode: 'all' | 'single';
  /** The file open in the single file view. */
  focused: AutoViewedFile | undefined;
  /** The files that were fully visible in the all-files diff view. */
  fullyVisible: Set<string>;
  /** The files already marked as viewed. */
  reviewed: Set<string>;
  /** The rendered files, to check whether one can be marked. */
  fileById: Map<string, AutoViewedFile>;
  markViewed: (itemIds: string[]) => void;
}

/**
 * Marks files as viewed while reviewing, when the user asked for it: a file
 * that was fully visible in the all-files diff view counts as read, and in
 * the single file view leaving a file counts.
 */
export function useAutoViewed({ enabled, prId, fileMode, focused, fullyVisible, reviewed, fileById, markViewed }: AutoViewedOptions): void {
  const latest = useRef({ enabled, prId, reviewed, fileById, markViewed });
  latest.current = { enabled, prId, reviewed, fileById, markViewed };

  const markable = (id: string): boolean => {
    const file = latest.current.fileById.get(id);
    return Boolean(file) && !file!.combined && !latest.current.reviewed.has(id);
  };

  useEffect(() => {
    if (!enabled || !prId || fileMode !== 'all') return;
    const fresh = [...fullyVisible].filter(markable);
    if (fresh.length) latest.current.markViewed(fresh);
  }, [enabled, prId, fileMode, fullyVisible]);

  useEffect(() => {
    if (!enabled || !prId || fileMode !== 'single' || !focused || focused.combined) return;
    const id = focused.id;
    return () => {
      const current = latest.current;
      // Turning the setting off or replacing the pull request is not leaving
      // the file; only a real navigation away counts.
      if (!current.enabled || current.prId !== prId) return;
      if (markable(id)) current.markViewed([id]);
    };
  }, [enabled, prId, fileMode, focused?.id]);
}
