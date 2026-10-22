import Image from 'next/image';
import type { ReactNode } from 'react';

/** Hack, the official character: header/side guidance only, never a pop-up. The artwork file is used unmodified; its copyright and trademark clearance are not verified (docs/ux/ux08-v2.md). */
export function HackGuide({ heading = 'Hack says', children, size = 80 }: { heading?: string; children: ReactNode; size?: number }) {
  return (
    <div className="hack-guide">
      {/* unoptimized: the origin lock refuses the image optimizer's internal fetch of this file (see SparkHeader) */}
      <Image src="/hack/hack-official.png" alt="Hack, the HackAss donkey" width={size} height={size} unoptimized />
      <blockquote><strong>{heading}</strong><br />{children}</blockquote>
    </div>
  );
}
