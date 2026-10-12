import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { processFile } from '@pierre/diffs';
import type { CodeViewItem, DiffLineAnnotation, FileDiffMetadata } from '@pierre/diffs';
import { CodeView, type CodeViewHandle, type CodeViewReactOptions } from '@pierre/diffs/react';
import { Button, Flash, useConfirm } from '@primer/react';
import { CommentDiscussionIcon, FileDiffIcon } from '@primer/octicons-react';
import type { Comment, MergeResult, PrStatus, ReviewSetDetail } from '../../../shared/types';
import { post } from '../../lib/api';
import { fileItemId } from '../../lib/format';
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

function MergeResultsFlash({ results }: { results: MergeResult[] }) {
  const failed = results.filter((result) => !result.ok);
  const variant = failed.length === 0 ? 'success' : failed.length === results.length ? 'danger' : 'warning';
  return (
    <Flash variant={variant}>
      <strong>{failed.length === 0 ? 'Merge complete' : failed.length === results.length ? 'Merge failed' : 'Merge partially complete'}</strong>
      <ul className="error-list">
        {results.map((result) => (
          <li key={`${result.repo}:${result.message}`}>
            {result.repo ? <span className="mono">{result.repo}: </span> : null}
            {result.message}
          </li>
        ))}
      </ul>
    </Flash>
  );
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
  const [merging, setMerging] = useState(false);
  const [mergeResults, setMergeResults] = useState<MergeResult[] | null>(null);
  const codeViewRef = useRef<CodeViewHandle<AnnotationMeta, undefined>>(null);
  const confirm = useConfirm();

  useEffect(() => setComments(pr.comments), [pr.comments]);

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

  const hasFiles = parsed.length > 0;

  const merge = useCallback(async () => {
    const openRepos = pr.repos.filter((repo) => repo.state === 'open' && repo.branch);
    if (!openRepos.length) return;
    const approved = await confirm({
      title: `Merge into ${reviewSet.targetBranch}?`,
      content: (
        <>
          <p>mureview will merge on GitHub:</p>
          <ul className="error-list">
            {openRepos.map((repo) => (
              <li key={repo.repo}>
                <span className="mono">
                  {repo.repo}: {repo.branch} → {reviewSet.targetBranch}
                </span>
              </li>
            ))}
          </ul>
          <p>When every matched branch is merged, this review closes and its comments are deleted.</p>
        </>
      ),
      confirmButtonContent: 'Merge',
      cancelButtonContent: 'Cancel',
    });
    if (!approved) return;

    setMerging(true);
    setMergeResults(null);
    try {
      const result = await post<{ results: MergeResult[]; detail: ReviewSetDetail }>(`/review-sets/${reviewSet.id}/merge`, {});
      setMergeResults(result.results);
      onDetail(result.detail);
    } catch (error) {
      setMergeResults([{ repo: '', ok: false, message: (error as Error).message }]);
    } finally {
      setMerging(false);
    }
  }, [pr, reviewSet, confirm, onDetail]);

  return (
    <div className="pr-page">
      <PrHeader detail={detail} onReload={onReload} onMerge={merge} merging={merging} />
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
                <FileTreePanel pr={pr} onSelectItem={(itemId) => codeViewRef.current?.scrollTo({ type: 'item', id: itemId, align: 'start' })} />
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
