'use client';
import { StateBox } from '@/src/ui/experience/StateBox';

export default function ExperienceError({ reset }: { error: Error; reset: () => void }) {
  return <StateBox kind="error" title="Something went wrong" actions={<button type="button" className="btn" onClick={reset}>Try again</button>}>This page could not be shown. Your temporary draft in this tab is unaffected.</StateBox>;
}
