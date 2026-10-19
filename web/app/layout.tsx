import type {Metadata,Viewport} from 'next';
import './globals.css';
export const metadata:Metadata={title:'DAILY DROP — 今日のショップ',description:'iPhoneで自分のVALORANTデイリーショップを確認。',manifest:'/manifest.webmanifest',icons:{icon:'/favicon.svg',apple:'/icons/apple-touch-icon.png'},appleWebApp:{capable:true,title:'DAILY DROP',statusBarStyle:'black-translucent'},robots:{index:false,follow:false}};
export const viewport:Viewport={width:'device-width',initialScale:1,viewportFit:'cover',themeColor:'#111318'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ja"><body>{children}</body></html>;}
