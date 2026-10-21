import { safeReturnPath } from '@/src/modules/identity';
import { SignInScreen } from '@/src/ui/account/SignInScreen';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HackAss — Sign in' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const sp = await searchParams;
  return <SignInScreen next={safeReturnPath(typeof sp.next === 'string' ? sp.next : undefined)} />;
}
