import Workspace from '@/components/workspace';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { config } from '@/lib/config';
import { findSession, SESSION_COOKIE } from '@/lib/auth';
export const dynamic = 'force-dynamic';
export default async function Page() {
  if (config().production && !findSession((await cookies()).get(SESSION_COOKIE)?.value))
    redirect('/login');
  return <Workspace />;
}
