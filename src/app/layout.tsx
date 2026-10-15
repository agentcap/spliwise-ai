import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Splitwise AI — A clearer share',
  description: 'Your personal expense and repayment workspace.',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
