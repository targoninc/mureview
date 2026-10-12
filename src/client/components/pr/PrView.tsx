import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { processFile } from '@pierre/diffs';
import type { CodeViewItem, DiffLineAnnotation, FileDiffMetadata } from '@pierre/diffs';
import { CodeView, type CodeViewHandle, type CodeViewReactOptions } from '@pierre/diffs/react';
import { Button, Checkbox } from '@primer/react';
import { CommentDiscussionIcon, FileDiffIcon } from '@primer/octicons-react';
import type { Comment, PrStatus, ReviewSetDetail } from '../../../shared/types';
import { put } from '../../lib/api';
import { orderByTree } from '../../lib/fileTree';
import { fileItemId } from '../../lib/format';
import { MergeResultsFlash, useMerge } from './merge';
import { PrStatusBanner } from './PrStatusBanner';
import { PrHeader } from './PrHeader';
import { FileTreePanel } from './FileTreePanel';
import { ConversationPanel } from './ConversationPanel';
import { CommentComposer, CommentThread } from './Comments';
import { type AnnotationMeta, type DraftMeta, groupThreads, isDraft, threadVersion } from './annotations';

interface ParsedFile {
  id: string;
  repo: string;
  path: string;
  fileDiff: FileDiffMetadata;
}

interface Draft {
  itemId: string;
  repo: string;
  path: string;
  line: number;
  side: 'additions' | 'deletions';
}

function parseFiles(pr: PrStatus): ParsedFile[] {
  const parsed: ParsedFile[] = [];
  for (const repo of pr.repos) {
    for (const file of repo.files ?? []) {
      if (!file.patch) continue;
      const id = fileItemId(repo.repo, file.path);
      const fileDiff = processFile(file.patch, { cacheKey: id });
      if (fileDiff) parsed.push({ id, repo: repo.repo, path: file.path, fileDiff });
    }
  }
  return parsed;
}

interface PrViewProps {
  detail: ReviewSetDetail;
  onReload: (fresh?: boolean) => void;
  onDetail: (detail: ReviewSetDetail) => void;
}

export function PrView({ detail, onReload, onDetail }: PrViewProps) {
  const { reviewSet, pr } = detail;
  const [tab, setTab] = useState<'files' | 'conversation'>('files');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [comments, setComments] = useState<Comment[]>(pr.comments);
  const [reviewed, setReviewedItems] = useState<Set<string>>(() => new Set(pr.reviewed.map((mark) => fileItemId(mark.repo, mark.path))));
  const [visibleItems, setVisibleItems] = useState<Set<string>>(new Set());
  const codeViewRef = useRef<CodeViewHandle<AnnotationMeta, undefined>>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const visibleFrame = useRef<number | null>(null);
  const visibleTrailing = useRef<number | null>(null);
  const { merge, merging, results: mergeResults } = useMerge(pr, reviewSet, onDetail);

  useEffect(() => setComments(pr.comments), [pr.comments]);
  useEffect(() => setReviewedItems(new Set(pr.reviewed.map((mark) => fileItemId(mark.repo, mark.path)))), [pr.reviewed]);

  const computeVisibleItems = useCallback(() => {
    const viewer = codeViewRef.current?.getInstance();
    const scroll = scrollRef.current;
    if (!viewer || !scroll) return;
    const bounds = scroll.getBoundingClientRect();
    const next = new Set<string>();
    for (const rendered of viewer.getRenderedItems()) {
      const rect = rendered.element.getBoundingClientRect();
      if (rect.bottom > bounds.top + 1 && rect.top < bounds.bottom - 1) next.add(rendered.id);
    }
    setVisibleItems((current) => (current.size === next.size && [...next].every((id) => current.has(id)) ? current : next));
  }, []);

  const updateVisibleItems = useCallback(() => {
    if (visibleFrame.current === null) {
      visibleFrame.current = requestAnimationFrame(() => {
        visibleFrame.current = null;
        computeVisibleItems();
      });
    }
    // Virtualized items mount after the scroll event, so check again once settled.
    if (visibleTrailing.current !== null) clearTimeout(visibleTrailing.current);
    visibleTrailing.current = window.setTimeout(() => {
      visibleTrailing.current = null;
      computeVisibleItems();
    }, 150);
  }, [computeVisibleItems]);

  useEffect(
    () => () => {
      if (visibleFrame.current !== null) cancelAnimationFrame(visibleFrame.current);
      if (visibleTrailing.current !== null) clearTimeout(visibleTrailing.current);
    },
    [],
  );

  const parsed = useMemo(() => parseFiles(pr), [pr]);
  // Match the file tree's order (directories first, then files, alphabetical).
  const ordered = useMemo(() => orderByTree(parsed.map((entry) => ({ ...entry, itemId: entry.id }))), [parsed]);

  useEffect(() => {
    const timer = setTimeout(updateVisibleItems, 150);
    return () => clearTimeout(timer);
  }, [ordered, updateVisibleItems]);
  const parsedById = useMemo(() => new Map(parsed.map((entry) => [entry.id, entry])), [parsed]);
  const parsedRef = useRef(parsedById);
  parsedRef.current = parsedById;

  const threadsByItem = useMemo(() => groupThreads(comments), [comments]);

  const items = useMemo<CodeViewItem<AnnotationMeta>[]>(
    () =>
      ordered.map((entry) => {
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
            repo: entry.repo,
            path: entry.path,
            side: draft.side,
            line: draft.line,
            comments: [],
          };
          annotations.push({ side: draft.side, lineNumber: draft.line, metadata: draftMeta });
        }
        return { id: entry.id, type: 'diff', fileDiff: entry.fileDiff, annotations, version: threadVersion(threads, draft?.itemId ?? null, entry.id) };
      }),
    [ordered, threadsByItem, draft],
  );

  const options = useMemo<CodeViewReactOptions<AnnotationMeta, undefined>>(
    () => ({
      theme: { dark: 'pierre-dark', light: 'pierre-light' },
      themeType: 'dark',
      diffStyle: 'unified',
      enableGutterUtility: true,
      stickyHeaders: true,
      hunkSeparators: 'line-info',
      layout: { paddingTop: 8, paddingBottom: 24, gap: 8 },
      onGutterUtilityClick: (range, context) => {
        const entry = parsedRef.current.get(context.item.id);
        if (!entry) return;
        setDraft({ itemId: entry.id, repo: entry.repo, path: entry.path, line: range.start, side: range.side ?? 'additions' });
      },
    }),
    [],
  );

  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<AnnotationMeta>) => {
      const meta = annotation.metadata;
      if (!meta) return null;
      if (isDraft(meta)) {
        return (
          <CommentComposer
            prId={pr.prId ?? 0}
            anchor={{ repo: meta.repo, path: meta.path, line: meta.line, side: meta.side }}
            autoFocus
            onCancel={() => setDraft(null)}
            onDone={(comment) => {
              setDraft(null);
              setComments((current) => [...current, comment]);
            }}
          />
        );
      }
      return <CommentThread comments={meta.comments} onDeleted={(id) => setComments((current) => current.filter((item) => item.id !== id))} />;
    },
    [pr.prId],
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
          files: files.map((file) => ({ repo: file.repo, path: file.path })),
        });
      } catch (error) {
        apply(!value);
        console.error('Could not update the reviewed state:', error);
      }
    },
    [pr.prId],
  );

  const renderHeaderMetadata = useCallback(
    (item: CodeViewItem<AnnotationMeta>) => {
      const entry = parsedRef.current.get(item.id);
      if (!entry || !pr.prId) return null;
      return (
        <label className="viewed-toggle" title="Mark this file as reviewed">
          <Checkbox checked={reviewed.has(entry.id)} onChange={() => applyReviewed([entry.id], !reviewed.has(entry.id))} />
          Viewed
        </label>
      );
    },
    [reviewed, applyReviewed, pr.prId],
  );

  const hasFiles = parsed.length > 0;
  const reviewedCount = parsed.filter((entry) => reviewed.has(entry.id)).length;

  return (
    <div className="pr-page">
      <PrHeader detail={detail} onReload={onReload} onMerge={merge} merging={merging} reviewedCount={reviewedCount} />
      <div className="pr-banners">
        <PrStatusBanner pr={pr} reviewSet={reviewSet} />
        {mergeResults ? <MergeResultsFlash results={mergeResults} /> : null}
      </div>
      <div className="pr-body">
        <aside className="pr-sidebar">
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
              variant={tab === 'conversation' ? 'primary' : 'invisible'}
              leadingVisual={CommentDiscussionIcon}
              onClick={() => setTab('conversation')}
            >
              Conversation ({comments.length})
            </Button>
          </div>
          <div className="pr-sidebar-content">
            {tab === 'files' ? (
              hasFiles ? (
                <FileTreePanel
                  pr={pr}
                  reviewedItems={reviewed}
                  visibleItems={visibleItems}
                  onSelectItem={(itemId) => codeViewRef.current?.scrollTo({ type: 'item', id: itemId, align: 'start' })}
                  onSetReviewed={applyReviewed}
                />
              ) : (
                <div className="empty-state">No text diffs to show.</div>
              )
            ) : (
              <ConversationPanel
                prId={pr.prId}
                comments={comments}
                onAdded={(comment) => setComments((current) => [...current, comment])}
                onDeleted={(id) => setComments((current) => current.filter((item) => item.id !== id))}
              />
            )}
          </div>
        </aside>
        <div className="pr-main">
          <div className="pr-diffs">
            {hasFiles ? (
              <CodeView
                ref={codeViewRef}
                items={items}
                options={options}
                containerRef={scrollRef}
                onScroll={updateVisibleItems}
                renderAnnotation={renderAnnotation}
                renderHeaderMetadata={renderHeaderMetadata}
                style={{ height: '100%', overflow: 'auto' }}
              />
            ) : (
              <div className="empty-state">There are no reviewable file changes in this pull request.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
