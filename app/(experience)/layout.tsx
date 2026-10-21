import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@/src/ui/experience/experience.css';
import { ExperienceProvider } from '@/src/ui/experience/ExperienceProvider';
import { Shell } from '@/src/ui/experience/Shell';
import { SessionProvider } from '@/src/ui/account/SessionProvider';
import { AccountBoundary } from '@/src/ui/work/AccountBoundary';

export const metadata: Metadata = {
  title: 'HackAss — The Spark',
  description: 'Discover a hack, shape a prompt with Hack, copy it out and reflect. Preview: nothing is saved.',
  robots: { index: false, follow: false },
};

export default function ExperienceLayout({ children }: { children: ReactNode }) {
  return <div className="hx"><ExperienceProvider><SessionProvider><AccountBoundary /><Shell>{children}</Shell></SessionProvider></ExperienceProvider></div>;
}
