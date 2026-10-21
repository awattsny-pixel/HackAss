import { PromptDetailScreen } from '@/src/ui/work/PromptDetailScreen';
export const metadata = { title: 'HackAss — My prompt' };
export default async function PromptDetailPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <PromptDetailScreen id={id} />; }
