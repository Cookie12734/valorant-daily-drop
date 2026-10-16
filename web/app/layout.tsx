import type {Metadata} from 'next';
import './globals.css';
export const metadata:Metadata={title:'DAILY DROP — 接続検証',description:'iPhoneからショップへの接続を確認します。',robots:{index:false,follow:false}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ja"><body>{children}</body></html>;}
