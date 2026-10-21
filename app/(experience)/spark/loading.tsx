import { StateBox } from '@/src/ui/experience/StateBox';

export default function Loading() {
  return (<><StateBox kind="loading">Loading the published catalog…</StateBox><div className="skeleton" aria-hidden="true" /></>);
}
