import type { Metadata } from 'next';
import { headers } from 'next/headers';
import './globals.css';
import './theme.css';
import './assistant.css';
import './workspace.css';

export const metadata: Metadata = {
  title: 'Splitwise AI — A clearer share',
  description: 'Your personal expense and repayment workspace.',
};

// Apply the saved preference before first paint so reloads do not flash the other theme.
const initializeTheme =
  "(function(){var theme='dark';try{var saved=localStorage.getItem('splitwise-ai-theme');if(saved==='light'||saved==='dark')theme=saved;}catch(e){}document.documentElement.dataset.theme=theme;})();";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce') || undefined;
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: initializeTheme }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
