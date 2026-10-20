import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAppContext } from '../../lib/appContext';
import { processFile } from '@pierre/diffs';
import type { CodeViewItem, DiffLineAnnotation, FileDiffMetadata } from '@pierre/diffs';
import { CodeView, type CodeViewHandle, type CodeViewReactOptions, WorkerPoolContextProvider } from '@pierre/diffs/react';
import { BranchName, Button, Checkbox, Dialog, Flash, IconButton, Label } from '@primer/react';
import { UserAvatar } from '../UserAvatar';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CommentDiscussionIcon,
  FileDiffIcon,
  GitCommitIcon,
  GitPullRequestIcon,
} from '@primer/octicons-react';
import type { Comment, PrStatus, RepoChecks, RepoStatus, ReviewMarkBy, ReviewSetDetail, ReviewVote } from '../../../shared/types';
import { api, post, put } from '../../lib/api';
import { checkTone } from '../../lib/checks';
import { orderByTree } from '../../lib/fileTree';
import { fileItemId, fileSegments, forgeAvatarUrl, parseItemId, repoItemKey, repoStatusText } from '../../lib/format';
import { repoLabel } from '../../../shared/types';
import { DEFAULT_DIFF_FONT_SIZE, diffLineHeight } from '../../../shared/fonts';
import { useLiveReviewSet, type LiveEvent } from '../../lib/live';
import { marksKey, writeCachedMarks } from '../../lib/markCache';
import { useAutoViewed } from '../../lib/useAutoViewed';
import { useIsMobile } from '../../lib/useIsMobile';
import { ServiceIcon, serviceDetail } from '../ServiceIcon';
import { PrStatusBanner } from './PrStatusBanner';
import { PrHeader } from './PrHeader';
import { CommitList } from './CommitList';
import { FileTreePanel } from './FileTreePanel';
import { ConversationPanel } from './ConversationPanel';
import { ReviewVoteButtons } from './ReviewVoteButtons';
import { CommentComposer, CommentThread } from './Comments';
import { type AnnotationMeta, type DraftMeta, groupThreads, isDraft, threadVersion } from './annotations';

interface ParsedFile {
  id: string;
  connectionId: number;
  host: string;
  repo: string;
  /** The stack layer the file belongs to; -1 for the combined view. */
  position: number;
  /** The tree segment naming the layer, for stacked review sets. */
  layer?: string;
  combined: boolean;
  path: string;
  fileDiff: FileDiffMetadata;
}

interface Draft {
  itemId: string;
  connectionId: number;
  repo: string;
  position: number;
  path: string;
  line: number;
  side: 'additions' | 'deletions';
}

/** The tree label of a stack layer, e.g. "Layer 2 · feature/part-2". */
function layerLabel(repo: RepoStatus): string | undefined {
  if (repo.position < 0) return undefined;
  return `Layer ${repo.position + 1} · ${repo.branch}`;
}

function parseFiles(pr: PrStatus, view: 'layers' | 'combined'): ParsedFile[] {
  const parsed: ParsedFile[] = [];
  const entries = view === 'combined' ? (pr.combined ?? []) : pr.repos;
  const stacked = Boolean(pr.combined);
  for (const repo of entries) {
    const layer = stacked && repo.position >= 0 ? layerLabel(repo) : undefined;
    for (const file of repo.files ?? []) {
      if (!file.patch) continue;
      const id = fileItemId(repo.connectionId, repo.repo, repo.position, file.path);
      const fileDiff = processFile(file.patch, { cacheKey: id });
      if (fileDiff) {
        parsed.push({
          id,
          connectionId: repo.connectionId,
          host: repo.host,
          repo: repo.repo,
          position: repo.position,
          layer,
          combined: repo.position < 0,
          path: file.path,
          fileDiff,
        });
      }
    }
  }
  return parsed;
}

interface PrViewProps {
  detail: ReviewSetDetail;
  onReload: (fresh?: boolean) => void;
  progress?: { loaded: number; total: number } | null;
}

export function PrView({ detail, onReload, progress }: PrViewProps) {
  const { reviewSet, pr } = detail;
  const { user } = useAppContext();
  const diffFontSize = user?.diffFontSize ?? DEFAULT_DIFF_FONT_SIZE;
  const diffLine = diffLineHeight(diffFontSize);
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const [searchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: 'files' | 'commits' | 'conversation' =
    tabParam === 'commits' || tabParam === 'conversation' ? tabParam : 'files';
  const setTab = useCallback(
    (next: 'files' | 'commits' | 'conversation') => {
      const params = new URLSearchParams(searchParams);
      if (next === 'files') params.delete('tab');
      else params.set('tab', next);
      const search = params.toString();
      navigate(
        { pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash },
        { replace: true },
      );
    },
    [navigate, searchParams, location.pathname, location.hash],
  );
  const [panel, setPanel] = useState<'files' | 'commits' | 'conversation' | null>(
    () => (isMobile && tab !== 'files' ? tab : null),
  );
  const [pullsOpen, setPullsOpen] = useState(false);
  const [votes, setVotes] = useState<Map<string, ReviewVote>>(new Map());
  const [pendingVote, setPendingVote] = useState<ReviewVote | null>(null);
  const [pendingRepo, setPendingRepo] = useState<string | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [collapsedChecks, setCollapsedChecks] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [comments, setComments] = useState<Comment[]>(pr.comments);
  const [reviewed, setReviewedItems] = useState<Set<string>>(
    () => new Set(pr.reviewed.map((mark) => fileItemId(mark.connectionId, mark.repo, mark.position, mark.path))),
  );
  const [visibleItems, setVisibleItems] = useState<Set<string>>(new Set());
  const [fullyVisibleItems, setFullyVisibleItems] = useState<Set<string>>(new Set());
  const [reviewedBy, setReviewedBy] = useState<ReviewMarkBy[]>(pr.reviewedBy ?? []);
  const [revealViewed, setRevealViewed] = useState(false);
  const [view, setView] = useState<'layers' | 'combined'>('layers');
  const [checks, setChecks] = useState<RepoChecks[]>([]);
  const [diffStyle, setDiffStyle] = useState<'unified' | 'split'>(
    () => (window.localStorage.getItem('mureview:diff-style') === 'split' ? 'split' : 'unified'),
  );
  const [fileMode, setFileMode] = useState<'all' | 'single'>(
    () => (window.localStorage.getItem('mureview:file-mode') === 'single' ? 'single' : 'all'),
  );
  const [headerCollapsed, setHeaderCollapsed] = useState(
    () => window.localStorage.getItem('mureview:header-collapsed') === '1',
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const toggleDiffStyle = useCallback(() => {
    setDiffStyle((current) => {
      const next = current === 'unified' ? 'split' : 'unified';
      window.localStorage.setItem('mureview:diff-style', next);
      return next;
    });
  }, []);
  const toggleHeaderCollapsed = useCallback(() => {
    setHeaderCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem('mureview:header-collapsed', next ? '1' : '0');
      return next;
    });
  }, []);
  const sidebarMin = 220;
  const sidebarMax = () => Math.max(sidebarMin, window.innerWidth - 520);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem('mureview:sidebar-width'));
    return Number.isFinite(stored) && stored > 0 ? Math.min(Math.max(stored, sidebarMin), sidebarMax()) : 320;
  });
  const codeViewRef = useRef<CodeViewHandle<AnnotationMeta, undefined>>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const visibleFrame = useRef<number | null>(null);
  const visibleTrailing = useRef<number | null>(null);
  const restoredFromUrl = useRef(false);
  const urlItem = useRef<string | null>(null);
  const urlAt = useRef(0);

  useEffect(() => setComments(pr.comments), [pr.comments]);
  useEffect(
    () => setReviewedItems(new Set(pr.reviewed.map((mark) => fileItemId(mark.connectionId, mark.repo, mark.position, mark.path)))),
    [pr.reviewed],
  );
  // Keep the browser cache of this user's checkmarks current, so the next
  // visit paints them right away.
  useEffect(() => {
    if (!user || !pr.prId) return;
    void writeCachedMarks(
      marksKey(user.id, reviewSet.id),
      [...reviewed].map((itemId) => parseItemId(itemId)),
    );
  }, [reviewed, pr.prId, reviewSet.id, user]);
  useEffect(() => {
    api<{ repos: RepoChecks[] }>(`/review-sets/${reviewSet.id}/checks`)
      .then((result) => setChecks(result.repos))
      .catch(() => undefined);
  }, [reviewSet.id]);
  useEffect(() => {
    window.localStorage.setItem('mureview:sidebar-width', String(sidebarWidth));
  }, [sidebarWidth]);

  const beginSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sidebarWidth;
      const move = (moveEvent: PointerEvent) => {
        setSidebarWidth(Math.min(Math.max(startWidth + moveEvent.clientX - startX, sidebarMin), sidebarMax()));
      };
      const finish = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        document.body.classList.remove('sidebar-resizing');
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      document.body.classList.add('sidebar-resizing');
    },
    [sidebarWidth],
  );

  const computeVisibleItems = useCallback((withUrl: boolean) => {
    const viewer = codeViewRef.current?.getInstance();
    const scroll = scrollRef.current;
    if (!viewer || !scroll) return;
    const bounds = scroll.getBoundingClientRect();
    const topEdge = bounds.top + 1;
    const bottomEdge = bounds.bottom - 1;

    // One layout read per rendered item; measuring inside a sort comparator
    // forces a reflow per comparison and makes scrolling large diffs janky.
    const measured: { id: string; top: number; bottom: number }[] = [];
    for (const rendered of viewer.getRenderedItems()) {
      const rect = rendered.element.getBoundingClientRect();
      measured.push({ id: rendered.id, top: rect.top, bottom: rect.bottom });
    }

    const next = new Set<string>();
    // Fully visible files can be marked as viewed automatically; see useAutoViewed.
    const nextFully = new Set<string>();
    let top: { id: string; top: number } | null = null;
    for (const item of measured) {
      if (item.bottom <= topEdge || item.top >= bottomEdge) continue;
      next.add(item.id);
      if (item.top >= topEdge && item.bottom <= bottomEdge) nextFully.add(item.id);
      if (!top || item.top < top.top) top = { id: item.id, top: item.top };
    }
    setVisibleItems((current) => (current.size === next.size && [...next].every((id) => current.has(id)) ? current : next));
    setFullyVisibleItems((current) =>
      current.size === nextFully.size && [...nextFully].every((id) => current.has(id)) ? current : nextFully,
    );

    // Keep the file being read (and the offset inside it) in the URL, so a
    // reload lands back at the same scroll position. Browsers throttle
    // history updates, so only rewrite it when the top file moved and a moment
    // has passed since the last write.
    if (withUrl && top && (top.id !== urlItem.current || performance.now() - urlAt.current > 500)) {
      urlItem.current = top.id;
      urlAt.current = performance.now();
      const within = Math.max(0, Math.round(bounds.top - top.top));
      const hash = `#file=${encodeURIComponent(top.id)}${within > 0 ? `&y=${within}` : ''}`;
      if (window.location.hash !== hash) {
        window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${hash}`);
      }
    }
  }, []);

  const updateVisibleItems = useCallback(() => {
    if (visibleFrame.current === null) {
      visibleFrame.current = requestAnimationFrame(() => {
        visibleFrame.current = null;
        computeVisibleItems(false);
      });
    }
    // Virtualized items mount after the scroll event, so check again once settled.
    if (visibleTrailing.current !== null) clearTimeout(visibleTrailing.current);
    visibleTrailing.current = window.setTimeout(() => {
      visibleTrailing.current = null;
      computeVisibleItems(true);
    }, 150);
  }, [computeVisibleItems]);

  useEffect(
    () => () => {
      if (visibleFrame.current !== null) cancelAnimationFrame(visibleFrame.current);
      if (visibleTrailing.current !== null) clearTimeout(visibleTrailing.current);
    },
    [],
  );

  const parsed = useMemo(() => parseFiles(pr, view), [pr, view]);
  // Match the file tree's order (directories first, then files, alphabetical).
  const ordered = useMemo(
    () =>
      orderByTree(
        parsed.map((entry) => ({
          ...entry,
          itemId: entry.id,
          segments: fileSegments(entry.host, entry.repo, entry.path, entry.layer),
        })),
      ),
    [parsed],
  );

  useEffect(() => {
    // The diff view renders its items lazily; retry so the first view is
    // measured (and its viewed marks made) even without a scroll.
    const timers = [150, 400, 800].map((delay) => window.setTimeout(updateVisibleItems, delay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [ordered, updateVisibleItems]);

  // The single file view shows one file; focus follows the tree, the deep
  // link and the previous/next buttons.
  const focusedEntry = ordered.find((entry) => entry.id === focusedId);
  const activeEntry = focusedEntry ?? ordered[0];
  const activeIndex = activeEntry ? ordered.indexOf(activeEntry) : -1;
  const previousEntry = activeIndex > 0 ? ordered[activeIndex - 1] : undefined;
  const nextEntry = activeIndex >= 0 && activeIndex < ordered.length - 1 ? ordered[activeIndex + 1] : undefined;
  const toggleFileMode = useCallback(() => {
    setFileMode((current) => {
      const next = current === 'all' ? 'single' : 'all';
      window.localStorage.setItem('mureview:file-mode', next);
      if (next === 'single') {
        const visible = ordered.find((entry) => visibleItems.has(entry.id));
        setFocusedId(visible?.id ?? ordered[0]?.id ?? null);
      }
      return next;
    });
  }, [ordered, visibleItems]);

  const treeVisibleItems = fileMode === 'single' && activeEntry ? new Set([activeEntry.id]) : visibleItems;

  const parsedById = useMemo(() => new Map(parsed.map((entry) => [entry.id, entry])), [parsed]);
  const parsedRef = useRef(parsedById);
  parsedRef.current = parsedById;

  const threadsByItem = useMemo(() => groupThreads(comments), [comments]);
  const viewersByItem = useMemo(() => {
    const map = new Map<string, ReviewMarkBy['user'][]>();
    for (const mark of reviewedBy) {
      const id = fileItemId(mark.connectionId, mark.repo, mark.position, mark.path);
      map.set(id, [...(map.get(id) ?? []), mark.user]);
    }
    return map;
  }, [reviewedBy]);

  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of comments) {
      if (!comment.path || comment.connectionId === null || !comment.repo) continue;
      const id = fileItemId(comment.connectionId, comment.repo, comment.position, comment.path);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [comments]);

  // Other tabs, devices and the forge itself push changes through the socket.
  const liveReload = useRef<number | null>(null);
  const onLiveEvent = useCallback(
    (event: LiveEvent) => {
      if (event.reviewSetId !== reviewSet.id) return;
      if ('prId' in event && event.prId !== undefined && pr.prId !== null && event.prId !== pr.prId) return;
      if (event.type === 'reviewed') {
        setReviewedBy((current) => {
          const viewer = { id: event.userId, name: event.userName ?? 'Someone', avatarUrl: event.userAvatar ?? '' };
          const ids = new Set(event.itemIds);
          const next = current.filter((mark) => {
            const id = fileItemId(mark.connectionId, mark.repo, mark.position, mark.path);
            return !(ids.has(id) && mark.user.id === event.userId);
          });
          if (event.reviewed) {
            for (const itemId of event.itemIds) {
                const parsed = parseItemId(itemId);
              next.push({ ...parsed, user: viewer });
            }
          }
          return next;
        });
        if (event.userId !== user?.id) return;
        setReviewedItems((current) => {
          const next = new Set(current);
          for (const id of event.itemIds) {
            if (event.reviewed) next.add(id);
            else next.delete(id);
          }
          return next;
        });
        return;
      }
      if (event.type === 'comment') {
        if (event.action === 'created') {
          const created = event.comment;
          setComments((current) => (current.some((comment) => comment.id === created.id) ? current : [...current, created]));
        } else if (event.action === 'deleted') {
          setComments((current) => current.filter((comment) => comment.id !== event.commentId));
        } else {
          setComments((current) =>
            current.map((comment) => (comment.id === event.commentId ? { ...comment, resolved: event.resolved ?? comment.resolved } : comment)),
          );
        }
        return;
      }
      if (event.type === 'vote') {
        if (event.userId !== user?.id) return;
        setVotes((current) => new Map(current).set(repoItemKey(event), event.vote));
        return;
      }
      if (event.type === 'comments' && pr.prId) {
        void api<{ comments: Comment[] }>(`/prs/${pr.prId}/comments`)
          .then((data) => setComments(data.comments))
          .catch(() => undefined);
        return;
      }
      if (event.type === 'prs') {
        if (liveReload.current !== null) return;
        liveReload.current = window.setTimeout(() => {
          liveReload.current = null;
          onReload(false);
        }, 800);
      }
    },
    [reviewSet.id, pr.prId, user?.id, onReload],
  );
  useLiveReviewSet(reviewSet.id, onLiveEvent);

  const buildItem = useCallback(
    (entry: (typeof ordered)[number]): CodeViewItem<AnnotationMeta> => {
      const threads = threadsByItem.get(entry.id) ?? [];
      const annotations: DiffLineAnnotation<AnnotationMeta>[] = threads.map((thread) => ({
        side: thread.side,
        lineNumber: thread.line,
        metadata: thread,
      }));
      if (draft?.itemId === entry.id) {
        const draftMeta: DraftMeta = {
          draft: true,
          threadKey: `${entry.id}:draft`,
          connectionId: entry.connectionId,
          repo: entry.repo,
          position: entry.position,
          path: entry.path,
          side: draft.side,
          line: draft.line,
          comments: [],
        };
        annotations.push({ side: draft.side, lineNumber: draft.line, metadata: draftMeta });
      }
      return { id: entry.id, type: 'diff', fileDiff: entry.fileDiff, annotations, version: threadVersion(threads, draft?.itemId ?? null, entry.id) };
    },
    [threadsByItem, draft],
  );

  const items = useMemo<CodeViewItem<AnnotationMeta>[]>(() => ordered.map(buildItem), [ordered, buildItem]);
  const singleItems = useMemo<CodeViewItem<AnnotationMeta>[]>(
    () => (activeEntry ? [buildItem(activeEntry)] : []),
    [activeEntry, buildItem],
  );

  const options = useMemo<CodeViewReactOptions<AnnotationMeta, undefined>>(
    () => ({
      theme: { dark: 'pierre-dark', light: 'pierre-light' },
      themeType: 'dark',
      diffStyle,
      enableGutterUtility: true,
      stickyHeaders: true,
      hunkSeparators: 'line-info',
      itemMetrics: { lineHeight: diffLine },
      layout: { paddingTop: 8, paddingBottom: 24, gap: 8 },
      onGutterUtilityClick: (range, context) => {
        const entry = parsedRef.current.get(context.item.id);
        if (!entry || entry.combined) return;
        setDraft({
          itemId: entry.id,
          connectionId: entry.connectionId,
          repo: entry.repo,
          position: entry.position,
          path: entry.path,
          line: range.start,
          side: range.side ?? 'additions',
        });
      },
      onLineNumberClick: (props, context) => {
        // Touch devices have no hover gutter; tapping a line number opens the
        // comment composer instead.
        if (!window.matchMedia('(pointer: coarse)').matches) return;
        if (!('annotationSide' in props)) return;
        const entry = parsedRef.current.get(context.item.id);
        if (!entry || entry.combined) return;
        setDraft({
          itemId: entry.id,
          connectionId: entry.connectionId,
          repo: entry.repo,
          position: entry.position,
          path: entry.path,
          line: props.lineNumber,
          side: props.annotationSide,
        });
      },
    }),
    [diffStyle, diffLine],
  );

  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<AnnotationMeta>) => {
      const meta = annotation.metadata;
      if (!meta) return null;
      if (isDraft(meta)) {
        return (
          <CommentComposer
            prId={pr.prId ?? 0}
            anchor={{ connectionId: meta.connectionId, repo: meta.repo, position: meta.position, path: meta.path, line: meta.line, side: meta.side }}
            autoFocus
            onCancel={() => setDraft(null)}
            onDone={(comment) => {
              setDraft(null);
              setComments((current) => [...current, comment]);
            }}
          />
        );
      }
      return (
        <CommentThread
          prId={pr.prId}
          comments={meta.comments}
          repos={pr.repos}
          onAdded={(comment) => setComments((current) => [...current, comment])}
          onDeleted={(id) => setComments((current) => current.filter((item) => item.id !== id))}
        />
      );
    },
    [pr.prId, pr.repos],
  );

  const applyReviewed = useCallback(
    async (itemIds: string[], value: boolean) => {
      if (!pr.prId) return;
      const files = itemIds.map((itemId) => parsedRef.current.get(itemId)).filter((entry): entry is ParsedFile => Boolean(entry));
      if (!files.length) return;

      const apply = (on: boolean) =>
        setReviewedItems((current) => {
          const copy = new Set(current);
          for (const file of files) {
            if (on) copy.add(file.id);
            else copy.delete(file.id);
          }
          return copy;
        });

      apply(value);
      try {
        await put(`/prs/${pr.prId}/reviewed`, {
          reviewed: value,
          files: files.map((file) => ({ connectionId: file.connectionId, repo: file.repo, position: file.position, path: file.path })),
        });
      } catch (error) {
        apply(!value);
        console.error('Could not update the reviewed state:', error);
      }
    },
    [pr.prId],
  );

  // Files that have been seen can leave the tree, when that setting is on.
  const treeEntries = useMemo(
    () => (view === 'combined' ? (pr.combined ?? []) : pr.repos),
    [view, pr.combined, pr.repos],
  );
  const viewedInTree = useMemo(() => {
    const ids = new Set<string>();
    for (const repo of treeEntries) {
      if (repo.position < 0) continue;
      for (const file of repo.files ?? []) {
        if (!file.patch) continue;
        const id = fileItemId(repo.connectionId, repo.repo, repo.position, file.path);
        if (reviewed.has(id)) ids.add(id);
      }
    }
    return ids;
  }, [treeEntries, reviewed]);
  const hideViewedPref = user?.hideViewedFiles ?? false;
  const hiddenViewedItems = hideViewedPref && !revealViewed ? viewedInTree : undefined;

  useAutoViewed({
    enabled: user?.autoMarkViewed ?? false,
    prId: pr.prId,
    fileMode,
    focused: activeEntry,
    fullyVisible: fullyVisibleItems,
    reviewed,
    fileById: parsedById,
    markViewed: (itemIds) => void applyReviewed(itemIds, true),
  });

  const renderHeaderMetadata = useCallback(
    (item: CodeViewItem<AnnotationMeta>) => {
      const entry = parsedRef.current.get(item.id);
      // Viewed marks belong to layers; the cumulative view is read-only.
      if (!entry || !pr.prId || entry.combined) return null;
      const viewers = viewersByItem.get(entry.id) ?? [];
      return (
        <>
          {viewers.length > 0 ? (
            <span className="viewed-avatars" title={viewers.map((viewer) => viewer.name).join(', ')}>
              {viewers.slice(0, 5).map((viewer) => (
                <UserAvatar key={viewer.id} src={viewer.avatarUrl} name={viewer.name} size={18} />
              ))}
              {viewers.length > 5 ? <span className="viewed-avatars-more">+{viewers.length - 5}</span> : null}
            </span>
          ) : null}
          <label className="viewed-toggle" title="Mark this file as reviewed">
            <Checkbox checked={reviewed.has(entry.id)} onChange={() => applyReviewed([entry.id], !reviewed.has(entry.id))} />
            Viewed
          </label>
        </>
      );
    },
    [reviewed, applyReviewed, pr.prId, viewersByItem],
  );

  const hasFiles = parsed.length > 0;

  // Restore the scroll position from the URL once the diffs are rendered.
  useEffect(() => {
    if (restoredFromUrl.current || !hasFiles) return;
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const file = params.get('file');
    if (!file || !parsed.some((entry) => entry.id === file)) return;
    restoredFromUrl.current = true;
    if (fileMode === 'single') {
      setFocusedId(file);
      return;
    }
    const offset = Number(params.get('y') ?? 0);
    const timer = window.setTimeout(() => {
      codeViewRef.current?.scrollTo({ type: 'item', id: file, align: 'start' });
      if (offset > 0) {
        window.setTimeout(() => {
          const scroll = scrollRef.current;
          if (scroll) scroll.scrollTop += offset;
        }, 120);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [hasFiles, parsed, fileMode]);
  const reviewedCount = parsed.filter((entry) => reviewed.has(entry.id)).length;
  const commitCount = pr.repos.reduce((count, repo) => count + (repo.commits?.length ?? 0), 0);
  const checksByRepo = useMemo(() => new Map(checks.map((entry) => [`${entry.connectionId}:${entry.repo}`, entry.checks])), [checks]);
  const checksFailing = checks.some((entry) => entry.checks.state === 'failure');
  const pullRequests = pr.repos.filter((repo) => repo.pullRequest);
  const reposWithoutPulls = pr.repos.filter((repo) => !repo.pullRequest && repo.position >= 0);

  // Ctrl+Shift+Arrow (Cmd+Shift+Arrow on macOS) moves between files while
  // the single file view is open.
  useEffect(() => {
    if (fileMode !== 'single') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      // Only text entry swallows the shortcut; checkboxes and buttons keep it.
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest(
            'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="password"], input[type="url"], input[type="tel"], input[type="number"]',
          ) !== null)
      ) {
        return;
      }
      const entry = event.key === 'ArrowUp' ? previousEntry : nextEntry;
      if (!entry) return;
      event.preventDefault();
      setFocusedId(entry.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fileMode, previousEntry, nextEntry]);

  const fileNavButton = (entry: (typeof ordered)[number] | undefined, direction: 'previous' | 'next') => (
    <button
      type="button"
      className="single-file-nav-button"
      disabled={!entry}
      aria-label={entry ? `${direction === 'previous' ? 'Previous' : 'Next'} file: ${entry.path}` : `No ${direction} file`}
      onClick={() => entry && setFocusedId(entry.id)}
    >
      {direction === 'previous' ? <ChevronUpIcon size={16} /> : <ChevronDownIcon size={16} />}
      <span className="single-file-nav-label">{direction === 'previous' ? 'Previous file' : 'Next file'}</span>
      <span className="single-file-nav-hint">{direction === 'previous' ? 'Ctrl+Shift+↑' : 'Ctrl+Shift+↓'}</span>
      {entry ? <span className="single-file-nav-path">{entry.path}</span> : null}
      <span className="single-file-nav-count">
        {activeIndex + 1} / {ordered.length}
      </span>
    </button>
  );

  const codeViewStyle = {
    height: '100%',
    overflow: 'auto',
    '--diffs-font-size': `${diffFontSize}px`,
    '--diffs-line-height': `${diffLine}px`,
  } as CSSProperties;

  const voteKey = repoItemKey;
  // No decision yet (or none of the reviewers voted) is no state at all.
  const voteOf = (repo: RepoStatus): ReviewVote | null => votes.get(voteKey(repo)) ?? repo.pullRequest?.review ?? null;
  const castVote = async (repo: RepoStatus, vote: ReviewVote) => {
    setVoteError(null);
    setPendingVote(vote);
    setPendingRepo(voteKey(repo));
    setVotes((current) => new Map(current).set(voteKey(repo), vote));
    try {
      await post(`/review-sets/${reviewSet.id}/review`, {
        connectionId: repo.connectionId,
        repo: repo.repo,
        position: repo.position,
        vote,
      });
    } catch (err) {
      setVoteError((err as Error).message);
      setVotes((current) => {
        const next = new Map(current);
        next.delete(voteKey(repo));
        return next;
      });
    } finally {
      setPendingVote(null);
      setPendingRepo(null);
    }
  };

  const reviewable = pr.repos.filter((repo) => repo.pullRequest?.review !== undefined && repo.position >= 0);
  const reviewState: ReviewVote | null =
    reviewable.length > 0 && reviewable.every((repo) => voteOf(repo) === voteOf(reviewable[0])) ? voteOf(reviewable[0]) : null;
  const [voting, setVoting] = useState(false);
  const voteOnAll = async (vote: ReviewVote) => {
    setVoting(true);
    setPendingVote(vote);
    setVoteError(null);
    try {
      for (const repo of reviewable) {
        await post(`/review-sets/${reviewSet.id}/review`, {
          connectionId: repo.connectionId,
          repo: repo.repo,
          position: repo.position,
          vote,
        });
        setVotes((current) => new Map(current).set(voteKey(repo), vote));
      }
    } catch (err) {
      setVoteError((err as Error).message);
    } finally {
      setVoting(false);
      setPendingVote(null);
    }
  };

  const openPanel = (next: 'files' | 'commits' | 'conversation') => {
    setTab(next);
    setPanel(next);
  };

  const panelContent =
    tab === 'commits' ? (
      <CommitList repos={pr.repos} target={reviewSet.targetBranch} />
    ) : tab === 'files' ? (
      hasFiles ? (
        <FileTreePanel
          pr={pr}
          entries={treeEntries}
          stacked={Boolean(pr.combined)}
          reviewedItems={reviewed}
          hiddenItems={hiddenViewedItems}
          visibleItems={treeVisibleItems}
          focusedItemId={fileMode === 'single' ? (activeEntry?.id ?? null) : null}
          commentCounts={commentCounts}
          onSelectItem={(itemId) => {
            if (fileMode === 'single') setFocusedId(itemId);
            else codeViewRef.current?.scrollTo({ type: 'item', id: itemId, align: 'start' });
            if (isMobile) setPanel(null);
          }}
          onSetReviewed={applyReviewed}
        />
      ) : (
        <div className="empty-state">No text diffs to show.</div>
      )
    ) : (
      <ConversationPanel
        prId={pr.prId}
        comments={comments}
        repos={pr.repos}
        onAdded={(comment) => setComments((current) => [...current, comment])}
        onDeleted={(id) => setComments((current) => current.filter((item) => item.id !== id))}
      />
    );

  return (
    <WorkerPoolContextProvider
      poolOptions={{
        // Highlighting runs in workers; on the main thread it re-tokenizes
        // items as they enter the virtual window and scrolling large diffs
        // stutters.
        workerFactory: () => new Worker(new URL('@pierre/diffs/worker/worker.js', import.meta.url), { type: 'module' }),
        poolSize: 2,
      }}
      highlighterOptions={{ theme: { dark: 'pierre-dark', light: 'pierre-light' } }}
    >
    <div className="pr-page">
      <PrHeader
        detail={detail}
        onReload={onReload}
        onMerge={() => navigate(`/review-sets/${reviewSet.id}/merge`)}
        reviewedCount={reviewedCount}
        compact={isMobile}
        commentCount={comments.length}
        commitCount={commitCount}
        diffStyle={diffStyle}
        onToggleDiffStyle={toggleDiffStyle}
        fileMode={fileMode}
        onToggleFileMode={toggleFileMode}
        collapsed={headerCollapsed}
        onToggleCollapsed={toggleHeaderCollapsed}
        hiddenViewedCount={hideViewedPref ? viewedInTree.size : 0}
        revealViewed={revealViewed}
        onToggleRevealViewed={() => setRevealViewed((current) => !current)}
        reviewState={reviewable.length > 0 ? reviewState : undefined}
        onVoteAll={reviewable.length > 0 ? voteOnAll : undefined}
        voting={voting}
        pendingVote={pendingVote}
        reviewRows={reviewable.map((repo) => ({
          key: voteKey(repo),
          label: repo.position > 0 ? `${repoLabel(repo)} · layer ${repo.position + 1}` : repoLabel(repo),
          vote: voteOf(repo),
          reviewers: repo.pullRequest?.reviewers?.map((reviewer) => ({
            ...reviewer,
            avatarUrl: forgeAvatarUrl(repo.kind, repo.connectionId, reviewer.avatarUrl),
          })),
        }))}
        progress={progress ?? null}
        onOpenFiles={() => openPanel('files')}
        onOpenCommits={() => openPanel('commits')}
        onOpenConversation={() => openPanel('conversation')}
        onShowPullRequests={() => setPullsOpen(true)}
        checksFailing={checksFailing}
      />
      <div className="pr-banners">
        {voteError ? <Flash variant="danger">{voteError}</Flash> : null}
        <PrStatusBanner pr={pr} reviewSet={reviewSet} />
      </div>
      <div className="pr-body">
        {isMobile ? null : (
          <>
            <aside className="pr-sidebar" style={{ width: sidebarWidth }}>
              <div className="pr-sidebar-tabs">
                <Button
                  size="small"
                  variant={tab === 'files' ? 'primary' : 'invisible'}
                  leadingVisual={FileDiffIcon}
                  onClick={() => setTab('files')}
                >
                  Files
                </Button>
                <Button
                  size="small"
                  variant={tab === 'commits' ? 'primary' : 'invisible'}
                  leadingVisual={GitCommitIcon}
                  onClick={() => setTab('commits')}
                >
                  Commits ({commitCount})
                </Button>
                <Button
                  size="small"
                  variant={tab === 'conversation' ? 'primary' : 'invisible'}
                  leadingVisual={CommentDiscussionIcon}
                  onClick={() => setTab('conversation')}
                >
                  Conversation ({comments.length})
                </Button>
              </div>
              <div className="pr-sidebar-content">{panelContent}</div>
            </aside>
            <div
              className="sidebar-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the file panel"
              onPointerDown={beginSidebarResize}
            />
          </>
        )}
        <div className="pr-main">
          {pr.combined ? (
            <div className="stack-view-toggle">
              <span className="stack-view-label">Stack view</span>
              <Button size="small" variant={view === 'layers' ? 'primary' : 'invisible'} onClick={() => setView('layers')}>
                Layer by layer
              </Button>
              <Button size="small" variant={view === 'combined' ? 'primary' : 'invisible'} onClick={() => setView('combined')}>
                All together
              </Button>
              <span className="stack-view-hint">
                {view === 'combined' ? (
                  <>
                    The whole stack against <BranchName>{reviewSet.targetBranch}</BranchName>. Comments belong to
                    layers, so switch back to Layer by layer to write them.
                  </>
                ) : (
                  'Every layer against the branch below it. Merging happens bottom-up.'
                )}
              </span>
            </div>
          ) : null}
          <div className="pr-diffs">
            {hasFiles ? (
              fileMode === 'single' ? (
                <div className="single-file-view">
                  <div className="single-file-nav">{fileNavButton(previousEntry, 'previous')}</div>
                  <CodeView
                    key={`single:${activeEntry?.id ?? ''}`}
                    ref={codeViewRef}
                    items={singleItems}
                    options={options}
                    containerRef={scrollRef}
                    onScroll={updateVisibleItems}
                    renderAnnotation={renderAnnotation}
                    renderHeaderMetadata={renderHeaderMetadata}
                    style={codeViewStyle}
                  />
                  <div className="single-file-nav">{fileNavButton(nextEntry, 'next')}</div>
                </div>
              ) : (
                <CodeView
                  key="all"
                  ref={codeViewRef}
                  items={items}
                  options={options}
                  containerRef={scrollRef}
                  onScroll={updateVisibleItems}
                  renderAnnotation={renderAnnotation}
                  renderHeaderMetadata={renderHeaderMetadata}
                  style={codeViewStyle}
                />
              )
            ) : (
              <div className="empty-state">There are no reviewable file changes in this pull request.</div>
            )}
          </div>
        </div>
      </div>

      {isMobile && panel ? (
        <Dialog
          title={panel === 'files' ? 'Files' : panel === 'commits' ? 'Commits' : 'Conversation'}
          width="calc(100vw - 24px)"
          height="auto"
          onClose={() => setPanel(null)}
          footerButtons={[{ content: 'Close', onClick: () => setPanel(null), buttonType: 'default' }]}
        >
          <div className="mobile-panel">{panelContent}</div>
        </Dialog>
      ) : null}

      {pullsOpen ? (
        <Dialog
          title="Pull requests"
          width="large"
          onClose={() => setPullsOpen(false)}
          footerButtons={[{ content: 'Close', onClick: () => setPullsOpen(false), buttonType: 'default' }]}
        >
          <div className="stack" style={{ gap: 20 }}>
            <div className="stack" style={{ gap: 0 }}>
              <strong style={{ fontSize: 12 }}>Pull requests</strong>
              {voteError ? <Flash variant="danger">{voteError}</Flash> : null}
              {pullRequests.length === 0 ? (
                <span style={{ color: 'var(--fgColor-muted)', fontSize: 12 }}>No pull requests yet.</span>
              ) : null}
              {pullRequests.map((repo) => {
                const repoChecks = checksByRepo.get(`${repo.connectionId}:${repo.repo}`);
                const key = `${repo.connectionId}:${repo.repo}`;
                const isCollapsed = collapsedChecks.has(key);
                return (
                  <div className="pr-checks-group" key={key}>
                    <div className="dialog-row">
                      {repoChecks && repoChecks.runs.length > 0 ? (
                        <IconButton
                          icon={isCollapsed ? ChevronRightIcon : ChevronDownIcon}
                          aria-label={isCollapsed ? 'Show checks' : 'Hide checks'}
                          variant="invisible"
                          size="small"
                          onClick={() =>
                            setCollapsedChecks((current) => {
                              const next = new Set(current);
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            })
                          }
                        />
                      ) : null}
                      <div className="stack" style={{ gap: 2, flex: 1, minWidth: 0 }}>
                        <span className="row" style={{ gap: 6 }}>
                          <ServiceIcon kind={repo.kind} detail={serviceDetail(repo.kind, repo)} />
                          <span className="mono" style={{ fontSize: 12 }}>
                            {repo.host}/{repo.repo}
                          </span>
                        </span>
                        <span className="row" style={{ gap: 6, color: 'var(--fgColor-muted)', fontSize: 12 }}>
                          {repo.branch ? <BranchName>{repo.branch}</BranchName> : null}
                          <span aria-hidden="true">→</span>
                          <BranchName>{repo.target || reviewSet.targetBranch}</BranchName>
                        </span>
                      </div>
                      <Button
                        as="a"
                        href={repo.pullRequest!.url}
                        target="_blank"
                        rel="noreferrer"
                        size="small"
                        leadingVisual={GitPullRequestIcon}
                      >
                        PR #{repo.pullRequest!.ref}
                      </Button>
                      {repo.pullRequest!.state === 'closed' ? <Label variant="secondary">Already closed</Label> : null}
                      {repo.pullRequest!.state === 'merged' ? <Label variant="success">Merged</Label> : null}
                    </div>
                    {repo.pullRequest?.review !== undefined &&
                    repo.pullRequest.state !== 'closed' &&
                    repo.pullRequest.state !== 'merged' ? (
                      <div style={{ paddingLeft: 8 }}>
                        <ReviewVoteButtons
                          vote={voteOf(repo)}
                          pending={pendingRepo === voteKey(repo) ? pendingVote : null}
                          onVote={(vote) => castVote(repo, vote)}
                        />
                      </div>
                    ) : null}
                    {repoChecks ? (
                      repoChecks.runs.length === 0 ? (
                        <span style={{ color: 'var(--fgColor-muted)', fontSize: 12, paddingLeft: 8 }}>
                          No checks reported for this branch.
                        </span>
                      ) : isCollapsed ? null : (
                        <div className="stack" style={{ gap: 6, paddingLeft: 8 }}>
                          {repoChecks.runs.map((run) => (
                            <div className="check-row" key={run.name}>
                              <span className={`check-dot checks-${run.state}`} />
                              <span style={{ flex: 1, minWidth: 0, fontSize: 12 }}>{run.name}</span>
                              {run.url ? (
                                <Button as="a" href={run.url} target="_blank" rel="noreferrer" size="small" variant="invisible">
                                  Details
                                </Button>
                              ) : null}
                              <Label variant={checkTone[run.state]}>{run.state}</Label>
                            </div>
                          ))}
                        </div>
                      )
                    ) : null}
                  </div>
                );
              })}
            </div>
            {reposWithoutPulls.length > 0 ? (
              <div className="stack" style={{ gap: 6 }}>
                <strong style={{ fontSize: 12 }}>Repositories without a pull request</strong>
                {reposWithoutPulls.map((repo) => (
                  <div className="dialog-row" key={`${repo.connectionId}:${repo.repo}`}>
                    <span className="row" style={{ gap: 6, fontSize: 12 }}>
                      <span className="mono">
                        {repo.host}/{repo.repo}
                      </span>
                      {repo.branch ? <BranchName>{repo.branch}</BranchName> : null}
                    </span>
                    <span style={{ color: repo.prError ? 'var(--fgColor-danger)' : 'var(--fgColor-muted)', fontSize: 12 }}>
                      {repo.prError ?? repoStatusText(repo)}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </Dialog>
      ) : null}
    </div>
    </WorkerPoolContextProvider>
  );
}
