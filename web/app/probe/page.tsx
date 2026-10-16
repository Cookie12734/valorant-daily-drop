import { requireChatGPTUser } from '../chatgpt-auth';
import Probe from './probe';
export const dynamic = 'force-dynamic';
export default async function Page(){await requireChatGPTUser('/probe'); return <Probe/>;}
