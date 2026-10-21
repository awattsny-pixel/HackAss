import { ResultDetailScreen } from '@/src/ui/work/ResultDetailScreen';
export const metadata = { title: 'HackAss — My result' };
export default async function ResultDetailPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <ResultDetailScreen id={id} />; }
