import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { processFile } from '@pierre/diffs';
import type { CodeViewItem, DiffLineAnnotation, FileDiffMetadata } from '@pierre/diffs';
import { CodeView, type CodeViewHandle, type CodeViewReactOptions } from '@pierre/diffs/react';
import { Button, Checkbox } from '@primer/react';
import { CommentDiscussionIcon, FileDiffIcon } from '@primer/octicons-react';
import type { Comment, PrStatus, ReviewSetDetail } from '../../../shared/types';
import { put } from '../../lib/api';
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
  const [reviewed, setReviewed] = useState<Set<string>>(() => new Set(pr.reviewed.map((mark) => fileItemId(mark.repo, mark.path))));
  const codeViewRef = useRef<CodeViewHandle<AnnotationMeta, undefined>>(null);
  const { merge, merging, results: mergeResults } = useMerge(pr, reviewSet, onDetail);

  useEffect(() => setComments(pr.comments), [pr.comments]);
  useEffect(() => setReviewed(new Set(pr.reviewed.map((mark) => fileItemId(mark.repo, mark.path)))), [pr.reviewed]);

  const parsed = useMemo(() => parseFiles(pr), [pr]);
  const parsedById = useMemo(() => new Map(parsed.map((entry) => [entry.id, entry])), [parsed]);
  const parsedRef = useRef(parsedById);
  parsedRef.current = parsedById;

  const threadsByItem = useMemo(() => groupThreads(comments), [comments]);

  const items = useMemo<CodeViewItem<AnnotationMeta>[]>(
    () =>
      parsed.map((entry) => {
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
    [parsed, threadsByItem, draft],
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

  const toggleReviewed = useCallback(
    async (itemId: string) => {
      const entry = parsedRef.current.get(itemId);
      if (!entry || !pr.prId) return;
      const next = !reviewed.has(itemId);
      const apply = (value: boolean) =>
        setReviewed((current) => {
          const copy = new Set(current);
          if (value) copy.add(itemId);
          else copy.delete(itemId);
          return copy;
        });

      apply(next);
      try {
        await put(`/prs/${pr.prId}/reviewed`, { repo: entry.repo, path: entry.path, reviewed: next });
      } catch (error) {
        apply(!next);
        console.error('Could not update the reviewed state:', error);
      }
    },
    [reviewed, pr.prId],
  );

  const renderHeaderMetadata = useCallback(
    (item: CodeViewItem<AnnotationMeta>) => {
      const entry = parsedRef.current.get(item.id);
      if (!entry || !pr.prId) return null;
      return (
        <label className="viewed-toggle" title="Mark this file as reviewed">
          <Checkbox checked={reviewed.has(entry.id)} onChange={() => toggleReviewed(entry.id)} />
          Viewed
        </label>
      );
    },
    [reviewed, toggleReviewed, pr.prId],
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
                  onSelectItem={(itemId) => codeViewRef.current?.scrollTo({ type: 'item', id: itemId, align: 'start' })}
                  onToggleReviewed={toggleReviewed}
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
