import { Avatar } from '@primer/react';

/**
 * An avatar that stays circular wherever it is used, with the name as its
 * accessible label. Sizing and rounding live in one place instead of every
 * caller re-implementing them.
 */
export function UserAvatar({
  src,
  name,
  size = 20,
  className,
}: {
  src?: string | null;
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <span className={className ? `user-avatar ${className}` : 'user-avatar'}>
      <Avatar src={src ?? ''} size={size} alt={name} />
    </span>
  );
}
