import Link from 'next/link';
import { DetailScreen } from '@/src/ui/experience/DetailScreen';
import { StateBox } from '@/src/ui/experience/StateBox';
import { findDemoHack } from '@/src/ui/experience/demo-hacks';

export default async function DemoDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const hack = findDemoHack(id);
  if (!hack) return <StateBox kind="empty" title="Demo example not found" actions={<Link className="btn" href="/spark/demo">Demo examples</Link>}>That demo example does not exist.</StateBox>;
  return <DetailScreen hack={hack} detail={null} />;
}
