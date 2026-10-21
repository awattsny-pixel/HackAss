'use client';
// The legacy site chrome (navigation, footer, auth context, Instagram embed script). The UX-08 experience routes bring their own
// chrome and must not load any of this (no auth call, no third-party script), so the root layout delegates the choice here.
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import Navigation from './Navigation';
import Footer from './Landing/Footer';
import { AuthProvider } from '../context/AuthContext';

const EXPERIENCE = ['/spark', '/lab', '/reveal', '/states', '/account'];
export function isExperiencePath(pathname: string): boolean {
  return EXPERIENCE.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

export default function LegacyChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (isExperiencePath(pathname)) return <>{children}</>;
  return (
    <AuthProvider>
      <script async src="https://www.instagram.com/embed.js"></script>
      <Navigation />
      <main className="flex-1">{children}</main>
      <Footer />
    </AuthProvider>
  );
}
