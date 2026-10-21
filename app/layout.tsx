import type { Metadata } from 'next';
import LegacyChrome from './components/LegacyChrome';
import './globals.css';

export const metadata: Metadata = {
  title: 'HackAss - Life Hacks That Work',
  description: 'Submit and vote on life hacks. Community-verified solutions that actually work.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-black text-white flex flex-col min-h-screen">
        <LegacyChrome>{children}</LegacyChrome>
      </body>
    </html>
  );
}
