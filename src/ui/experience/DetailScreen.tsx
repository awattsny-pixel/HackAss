'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useExperience } from './ExperienceProvider.tsx';
import { HackGuide } from './HackGuide.tsx';
import { AI_LABEL, costRange, DIFFICULTY_LABEL, formatDate, timeRange, toneFor } from './format.ts';
import { safeHref } from './safe-href.ts';
import { HighlightedPrompt } from './HighlightedPrompt.tsx';
import type { EditorDraft } from './guided.ts';
import { HackActions, type Version } from './HackActions.tsx';
import type { ExperienceHack } from './types.ts';

export interface DetailData {
  readonly outcome: string | null; readonly estimate_basis: string | null; readonly limitations: string | null; readonly published_at: string;
  readonly difficulty: 'easy' | 'moderate' | 'hard' | null; readonly time_minutes: { min: number | null; max: number | null };
  readonly cost: { min_cents: number | null; max_cents: number | null; currency: string | null }; readonly ai_requirement: 'none' | 'helpful' | 'required' | null;
  readonly steps: readonly { position: number; body: string }[]; readonly materials: readonly { position: number; name: string; detail: string | null }[];
  readonly requirements: readonly { kind: string; name: string; detail: string | null }[]; readonly tags: readonly string[];
  readonly attributions: readonly { role: string; name: string | null; url: string | null }[];
  readonly sources: readonly { kind: string; url: string | null; author: string | null; license: string | null; license_version: string | null }[];
}

function Link2({ href, children }: { href: string | null; children: string }) {
  const safe = safeHref(href);
  return safe ? <a href={safe} target="_blank" rel="noopener noreferrer nofollow">{children}</a> : <span>{children}</span>;
}

export function DetailScreen({ hack, detail }: { hack: ExperienceHack; detail: DetailData | null }) {
  const router = useRouter();
  const { state, view, dispatch, confirmThen, copy } = useExperience();
  const [version, setVersion] = useState<Version>('mine'); // a view choice only
  // Opening a detail page (including by direct link) selects the hack, which enables guarded Detail navigation.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when the hack changes
  useEffect(() => { view(hack); }, [hack.key, hack.source]);
  const adapt = () => confirmThen('adapt', () => { dispatch({ type: 'startFromHack', hack }); router.push('/lab'); });
  // The draft is THIS hack's once it has been started from it. Until then the page shows the hack as published, and choosing a highlighted part starts the draft
  // through the same replace-draft guard as "Make it yours" (Cancel changes nothing). After that the page and the Lab edit the very same draft.
  const bound = state.started && state.origin !== null && state.origin.source === hack.source && state.origin.key === hack.key;
  const fields = bound ? state.fields : { title: hack.title, goal: hack.goal, context: hack.context, format: hack.format };
  const mine = bound ? state.fullPrompt : hack.starterPrompt;
  const shown = (version === 'original' ? hack.starterPrompt : mine).trim();
  // The editor's unapplied text lives in the shared state for this draft generation (a reset or replacement clears it; a stale Apply changes nothing).
  // Apply on the Hack page: the first change starts the draft through the replace-draft guard (Cancel keeps everything, and the editor stays open with what was typed);
  // after that the page and the Lab edit the very same draft.
  const editorKey = `hack:${hack.source}:${hack.key}`;
  const gen = state.draftGen;
  const apply = (e: EditorDraft) => {
    if (bound) { dispatch({ type: 'applyEditor', gen, key: editorKey }); return; }
    confirmThen('adapt', () => dispatch({ type: 'startFromHack', hack, apply: { slot: e.slot, value: e.value }, expectGen: gen }), { exceptEditor: editorKey });
  };
  const demo = hack.source === 'demo';
  const t = detail ? timeRange(detail.time_minutes) : null; const c = detail ? costRange(detail.cost) : null;
  return (
    <>
      <div className="sectiontop"><Link className="btn subtle" href={demo ? '/spark/demo' : '/spark'}>← Back to discovery</Link></div>
      {demo ? <div className="banner demo" role="note"><strong>Demo mode.</strong> This is a draft example written for design review, not a catalog hack.</div> : null}
      <div className={`hero-card tone-${toneFor(hack.category)}`}>
        <div className="actions">
          {demo ? <span className="draft-pill">Draft example · not in the catalog</span> : <span className="live-pill">Published catalog hack</span>}
          <span className="meta">{hack.category}</span>
        </div>
        <h1>{hack.title}</h1>
        <p className="lead">{hack.summary}</p>
        {detail ? <div className="badges">
          {detail.difficulty ? <span className="badge">{DIFFICULTY_LABEL[detail.difficulty]}</span> : null}
          {t ? <span className="badge">{t}</span> : null}{c ? <span className="badge">{c}</span> : null}
          {detail.ai_requirement ? <span className="badge">{AI_LABEL[detail.ai_requirement]}</span> : null}
        </div> : null}
      </div>
      <div className="detail-grid hack-grid">
        <div className="col-main">
          <section className="panel prompt-card" aria-labelledby="pc-h">
            <div className="pc-head"><h2 id="pc-h">Your prompt</h2><span className="muted small" id="pc-hint">{version === 'original' ? 'Original, read only' : bound ? 'Edited here and in the Lab: one draft' : 'Tap a highlight to change it'}</span></div>
            <HighlightedPrompt idPrefix="hack" fields={fields} fullPrompt={mine} original={bound && version === 'original' ? hack.starterPrompt : null}
              editor={state.pending.editors[editorKey] ?? null} onEditor={(editor) => dispatch({ type: 'setEditor', gen, key: editorKey, editor })} onApply={apply} />
            {!demo ? <p className="muted small">Built from this hack&apos;s published details, not by AI.</p> : null}
          </section>
          <div className="panel col-details">
          <section><h3>What you&apos;ll accomplish</h3><p>{hack.goal}</p></section>
          {detail && detail.requirements.length ? <section><h3>What you need</h3><ul className="plain-list">{detail.requirements.map((r, i) => <li key={i}><strong>{r.name}</strong>{r.detail ? ` — ${r.detail}` : ''}</li>)}</ul></section> : null}
          {detail && detail.materials.length ? <section><h3>Materials</h3><ul className="plain-list">{[...detail.materials].sort((a, b) => a.position - b.position).map((m, i) => <li key={i}><strong>{m.name}</strong>{m.detail ? ` — ${m.detail}` : ''}</li>)}</ul></section> : null}
          {detail && detail.steps.length ? <section><h3>Steps</h3><ol className="steps-list">{[...detail.steps].sort((a, b) => a.position - b.position).map((s) => <li key={s.position}>{s.body}</li>)}</ol></section> : null}
          {detail?.limitations ? <section><h3>Limits to know</h3><p>{detail.limitations}</p></section> : null}
          </div>
        </div>
        <div className="col-side">
          <HackActions bound={bound} version={version} onVersion={setVersion} shown={shown} copyLabel={bound && version === 'mine' ? 'Copy my version' : 'Copy prompt'} onCopy={() => { void copy(shown); }} onLab={() => (bound ? router.push('/lab') : adapt())} />
        <aside className="panel col-aside">
          <HackGuide>“Start with a goal. Add constraints. Then make the AI explain its assumptions. See? You&apos;re already getting dangerous.”</HackGuide>
          <section>
            <h3>Evidence &amp; provenance</h3>
            {demo ? <p className="muted small">Created as demonstration content for UX review. No tests, community attempts, usage statistics, or verification available.</p> : detail ? (
              <>
                <p className="muted small">Published {formatDate(detail.published_at)} after review. {detail.estimate_basis ? `Estimates: ${detail.estimate_basis}` : ''}</p>
                {detail.attributions.length ? <ul className="plain-list small">{detail.attributions.map((a, i) => <li key={i}>Credited as {a.role.replace(/_/g, ' ')}: <Link2 href={a.url}>{a.name ?? 'name not given'}</Link2></li>)}</ul> : null}
                {detail.sources.length ? <ul className="plain-list small">{detail.sources.map((s, i) => <li key={i}>Source type, as stated: {s.kind.replace(/_/g, ' ')}{s.author || s.url ? <> — <Link2 href={s.url}>{s.author ?? s.url ?? ''}</Link2></> : null}{s.license ? ` · licence: ${s.license}${s.license_version ? ` ${s.license_version}` : ''}` : ''}</li>)}</ul> : null}
                <p className="muted small">Credits and sources are shown as submitted by the contributor.</p>
                <p className="muted small">No community attempts or success statistics are shown: none exist in this preview.</p>
              </>
            ) : null}
          </section>
          <section><h3>What&apos;s next?</h3><p className="muted small">Want to learn why this prompt is structured this way? Open The Lab and choose Learn It.</p></section>
        </aside>
        </div>
      </div>
    </>
  );
}
