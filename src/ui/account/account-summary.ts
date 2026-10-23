// What the compact account entry (rail and phone header) says about the session: the state, never "verified".
export function accountSummary(status: string): { name: string; short: string } {
  switch (status) {
    case 'member': return { name: 'Signed in', short: 'Account' };
    case 'degraded': return { name: 'Signed in, can’t check right now', short: 'Account' };
    case 'unavailable': return { name: 'Can’t check sign-in right now', short: 'Account' };
    case 'checking': return { name: 'Checking sign-in', short: 'Account' };
    default: return { name: 'Not signed in', short: 'Sign in' };
  }
}

