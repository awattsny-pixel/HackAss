'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useAuth } from '@/app/context/AuthContext';
import { useRouter } from 'next/navigation';

export default function Navigation() {
  const { user, logout } = useAuth();
  const router = useRouter();

  const handleLogout = async () => {
    await logout();
    router.push('/');
  };

  const handleSignIn = () => {
    router.push('/auth/login');
  };

  return (
    <header className="sticky top-0 z-50 bg-black border-b border-gray-800">
      <nav className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
        {/* Logo with Mascot */}
        <Link href="/" className="flex items-center gap-3 hover:opacity-80 transition">
          <div className="relative w-10 h-10">
            <Image
              src="/mascot.png"
              alt="HackAss Mascot"
              width={40}
              height={40}
              className="w-full h-full object-contain"
              priority
            />
          </div>
          <span className="text-2xl font-bold text-blue-500">hackass</span>
        </Link>

        {/* Center Navigation */}
        <div className="hidden md:flex items-center gap-8">
          <Link href="/browse" className="text-gray-300 hover:text-white transition">
            Browse
          </Link>
          <Link href="/categories" className="text-gray-300 hover:text-white transition">
            Categories
          </Link>
          <Link href="/submit" className="text-gray-300 hover:text-white transition">
            Submit
          </Link>
          <Link href="/manifesto" className="text-gray-300 hover:text-white transition">
            Manifesto
          </Link>
        </div>

        {/* Right: Auth Buttons */}
        <div className="flex items-center gap-4">
          {user ? (
            <>
              <Link
                href={`/profile/${user.username}`}
                className="text-gray-300 hover:text-white transition font-semibold"
              >
                {user.username}
              </Link>
              <button
                onClick={handleLogout}
                className="text-gray-300 hover:text-white transition"
              >
                Logout
              </button>
            </>
          ) : (
            <>
              <button
                onClick={handleSignIn}
                className="text-gray-300 hover:text-white transition"
              >
                Sign in
              </button>
              <button className="bg-white text-black font-semibold px-4 py-2 rounded-full hover:bg-gray-100 transition">
                Get the app
              </button>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}
