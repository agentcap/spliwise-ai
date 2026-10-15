import type { Metadata } from 'next';
import './globals.css';
import './theme.css';

export const metadata: Metadata = {
  title: 'Splitwise AI — A clearer share',
  description: 'Your personal expense and repayment workspace.',
};

// Apply the saved preference before first paint so reloads do not flash the other theme.
const initializeTheme =
  "(function(){var theme='dark';try{var saved=localStorage.getItem('splitwise-ai-theme');if(saved==='light'||saved==='dark')theme=saved;}catch(e){}document.documentElement.dataset.theme=theme;})();";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: initializeTheme }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
