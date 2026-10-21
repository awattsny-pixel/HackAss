import Link from 'next/link';
import { DetailScreen } from '@/src/ui/experience/DetailScreen';
import { StateBox } from '@/src/ui/experience/StateBox';
import { hackFromCatalog } from '@/src/ui/experience/prompt';
import { readHack } from '../../../_server/catalog';

export const dynamic = 'force-dynamic';

export default async function CatalogDetail({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const r = await readHack(slug);
  if (!r.ok) {
    const back = <Link className="btn" href="/spark">The Spark</Link>;
    if (r.kind === 'not_found') return <StateBox kind="empty" title="This hack is not available" actions={back}>It may not exist, or it is no longer published.</StateBox>;
    if (r.kind === 'denied') return <StateBox kind="denied" title="The hack could not be opened" actions={back}>We couldn&apos;t open this hack right now. Nothing else has been shown in its place.</StateBox>;
    return <StateBox kind="error" title="The hack could not be loaded" actions={back}>Please try again. Nothing has been replaced with other content.</StateBox>;
  }
  return <DetailScreen hack={hackFromCatalog(r.hack)} detail={r.hack} />;
}
