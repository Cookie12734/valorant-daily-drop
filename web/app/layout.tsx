import type {Metadata,Viewport} from 'next';
import './globals.css';
export const metadata:Metadata={title:'DAILY DROP — 今日のショップ',description:'iPhoneで自分のVALORANTデイリーショップを確認。',manifest:'/manifest.webmanifest',icons:{icon:'/favicon.svg',apple:'/icons/apple-touch-icon.png'},appleWebApp:{capable:true,title:'DAILY DROP',statusBarStyle:'black-translucent'},robots:{index:false,follow:false}};
export const viewport:Viewport={width:'device-width',initialScale:1,viewportFit:'cover',themeColor:'#0f1923'};
// Vinext does not currently emit appleWebApp metadata; include the iOS hints explicitly.
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ja"><head><meta name="apple-mobile-web-app-capable" content="yes"/><meta name="apple-mobile-web-app-title" content="DAILY DROP"/><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/></head><body>{children}</body></html>;}
