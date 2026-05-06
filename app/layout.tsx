import type { Metadata } from 'next';
import Navigation from './components/Navigation';
import Footer from './components/Landing/Footer';
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
      <head>
        <script async src="https://www.instagram.com/embed.js"></script>
      </head>
      <body className="bg-black text-white flex flex-col min-h-screen">
        <Navigation />
        <main className="flex-1">
          {children}
        </main>
        <Footer />
      </body>
    </html>
  );
}
