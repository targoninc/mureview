import { useParams } from 'react-router-dom';
import { Flash, Spinner } from '@primer/react';
import { PrView } from '../components/pr/PrView';
import { useDetail } from '../lib/useDetail';

export function ReviewSetPage() {
  const { id } = useParams();
  const { detail, error, reload } = useDetail(id);

  if (error) {
    return (
      <div className="page-scroll">
        <div className="page-inner">
          <Flash variant="danger">{error}</Flash>
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="centered">
        <Spinner size="large" aria-label="Loading review set" />
      </div>
    );
  }

  return <PrView detail={detail} onReload={reload} />;
}
