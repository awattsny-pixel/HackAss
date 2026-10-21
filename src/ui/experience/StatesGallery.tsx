import Link from 'next/link';
import { StateBox } from './StateBox.tsx';

/** Design-review gallery: every state treatment, shown statically. These are SIMULATIONS; no server, permission check or AI is involved. */
export function StatesGallery() {
  return (
    <>
      <div className="sectiontop"><div><span className="eyebrow">DESIGN REVIEW</span><h1>Interface states</h1><p className="lead">The treatments used across the journey. Examples only; nothing here reflects a real server response or permission check.</p></div><Link className="btn subtle" href="/spark">← The Spark</Link></div>
      <div className="panel">
        <h3>Loading</h3><StateBox kind="loading">Loading the published catalog…</StateBox><div className="skeleton" aria-hidden="true" />
        <h3 style={{ marginTop: 18 }}>Empty</h3><StateBox kind="empty" title="No published hacks yet">The catalog is empty.</StateBox>
        <h3>Error</h3><StateBox kind="error" title="The catalog could not be loaded" actions={<button type="button" className="btn">Try again</button>}>Please try again. Nothing has been replaced with other content.</StateBox>
        <h3>Access denied</h3><StateBox kind="denied" title="You cannot access this">Example access-denied state. This does not mean a real permission check occurred.</StateBox>
        <h3>AI unavailable</h3><StateBox kind="ai">Copy the prompt to use it in your own AI tool. Hack is not generating content here.</StateBox>
      </div>
    </>
  );
}
