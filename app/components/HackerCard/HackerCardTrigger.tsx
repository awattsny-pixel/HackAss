'use client';

import Link from 'next/link';
import { Popover } from '@/app/components/Common/Popover';
import { HackerCardContent } from './HackerCardContent';
import { useHackerCardData } from '@/app/hooks/useHackerCardData';

interface HackerCardTriggerProps {
  username: string;
  children?: React.ReactNode;
  showVerificationBadge?: boolean;
}

export function HackerCardTrigger({
  username,
  children,
}: HackerCardTriggerProps) {
  const { data, loading, fetch } = useHackerCardData(username);

  const handlePopoverOpen = () => {
    if (!data) {
      fetch();
    }
  };

  const trigger = children ? (
    <span onMouseEnter={handlePopoverOpen}>{children}</span>
  ) : (
    <Link
      href={`/profile/${username}`}
      className="text-blue-500 hover:underline"
      onMouseEnter={handlePopoverOpen}
    >
      @{username}
    </Link>
  );

  return (
    <Popover
      trigger={trigger}
      content={
        loading ? (
          <div className="p-4 text-gray-400 text-sm">Loading profile...</div>
        ) : data ? (
          <HackerCardContent data={data} />
        ) : (
          <div className="p-4 text-gray-400 text-sm">Profile not found</div>
        )
      }
      side="bottom"
      align="center"
      delayMs={300}
    />
  );
}
