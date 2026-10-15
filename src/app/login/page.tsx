import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { config } from '@/lib/config';
import { findSession, SESSION_COOKIE } from '@/lib/auth';
export const dynamic = 'force-dynamic';
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const error = (await searchParams).error;
  if (!config().production || findSession((await cookies()).get(SESSION_COOKIE)?.value))
    redirect('/');
  return (
    <main className="auth-page">
      <section className="auth-card">
        <span className="eyebrow">SPLITWISE AI</span>
        <h1>A clearer share.</h1>
        <p>Sign in to your private expense workspace. Splits stay under your control.</p>
        {error && (
          <p className="notice error" role="alert">
            {error === 'access'
              ? 'This account is not invited or is unavailable. Contact the operator.'
              : 'Sign-in could not be completed. Please try again.'}
          </p>
        )}
        <a className="primary auth-link" href="/auth/login">
          Sign in securely
        </a>
        <p className="muted">
          Access is by invitation. Manage passwords, recovery and multi-factor authentication with
          your sign-in provider.
        </p>
        <Link href="/privacy">Privacy & data</Link>
      </section>
    </main>
  );
}
