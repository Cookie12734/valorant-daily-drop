import {requireChatGPTUser} from './chatgpt-auth';
import Shop from './shop';
export const dynamic = 'force-dynamic';
export default async function Home(){
  const user = await requireChatGPTUser('/');
  const hash = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(user.userId));
  const storageKey = 'daily-drop:v1:' + Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');
  return <Shop storageKey={storageKey}/>;
}
