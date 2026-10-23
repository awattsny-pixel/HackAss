'use client';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useExperience } from './ExperienceProvider.tsx';

/** Home: the question, a prominent "Create a prompt" entry, and the source switch. "Create a prompt" is always available; it asks before replacing unsaved work. */
export function SparkHeader({ mode, exploreHref }: { mode: 'catalog' | 'demo'; exploreHref: string | null }) {
  const router = useRouter();
  const { confirmThen, dispatch } = useExperience();
  const create = () => confirmThen('new', () => { dispatch({ type: 'startBlank' }); router.push('/lab'); });
  return (
    <>
      <div className="hero">
        <div>
          <span className="eyebrow">The Spark</span>
          <h1>What do you want to hack?</h1>
          <p className="lead">Real-world ideas worth trying. Copy a prompt, make it your own, and bring back what happened.</p>
          <button type="button" className="create-card" onClick={create}>
            <span className="create-mark" aria-hidden="true">+</span>
            <span><b>Create a prompt</b><span className="sub">Start from a blank prompt. Always free.</span></span>
          </button>
          <div className="actions" style={{ marginTop: 12 }}>
            {exploreHref ? <Link className="btn" href={exploreHref}>Explore a hack</Link> : <button type="button" className="btn" disabled title="No hack to explore yet">Explore a hack</button>}
          </div>
        </div>
        <div className="hack-hero">
          {/* unoptimized: the origin lock refuses the image optimizer's internal fetch of this file, so the browser loads it directly through the edge */}
          <Image src="/hack/hack-official.png" alt="Hack, the HackAss donkey" width={120} height={120} priority unoptimized />
          <div className="hack-quote">“Good ideas are contagious. Let&apos;s make yours dangerous—in a useful way.”</div>
        </div>
      </div>
      <nav className="modeswitch" aria-label="Spark source">
        <Link href="/spark" aria-current={mode === 'catalog' ? 'page' : undefined}>Published catalog</Link>
        <Link href="/spark/demo" aria-current={mode === 'demo' ? 'page' : undefined}>Demo examples</Link>
      </nav>
    </>
  );
}
