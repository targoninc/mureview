import type { CheckInfo } from '../../shared/types';

/** Label tone per check state, shared by the merge page and the PR dialog. */
export const checkTone: Record<CheckInfo['state'], 'success' | 'danger' | 'attention' | 'secondary'> = {
  success: 'success',
  failure: 'danger',
  pending: 'attention',
  neutral: 'secondary',
  skipped: 'secondary',
  unknown: 'attention',
};
