import Link from 'next/link';
export const dynamic = 'force-dynamic';
export default function Privacy() {
  return (
    <main className="privacy-page">
      <Link href="/">← Back to workspace</Link>
      <h1>Privacy & data</h1>
      <p>Last updated October 15, 2026.</p>
      <h2>What is stored</h2>
      <p>
        This app stores your imported statement rows, transactions, people, split proposals, rules,
        repayments, instructions, conversations and action history in your private workspace on the
        operator’s server. Account identifiers and session hashes are stored separately for sign-in.
        Other users cannot access your workspace.
      </p>
      <h2>When AI is used</h2>
      <p>
        AI is optional. When you enable it and request processing, necessary transaction details,
        names and relationship tags, approved rules, saved context and recent conversation are sent
        to OpenAI through its API. Approved rule matching and manual review can work without AI. The
        agent can propose splits but cannot finalize transactions or record repayments.
      </p>
      <p>
        Hosted agent tracing is disabled and API response storage is disabled. These settings do not
        establish zero data retention. OpenAI’s applicable API data retention and abuse monitoring
        policies still apply.{' '}
        <a href="https://developers.openai.com/api/docs/guides/your-data" rel="noreferrer">
          Read OpenAI’s API data controls
        </a>
        .
      </p>
      <h2>Retention and removal</h2>
      <p>
        Financial records and Undo history remain until you delete your workspace. Default scheduled
        cleanup removes abandoned import drafts after 7 days, conversations after 90 days, and
        finished job records after 30 days. Operator-configured retention may differ; ask the person
        operating this instance for its policy.
      </p>
      <p>
        In Settings you can download your full workspace or request permanent deletion. Deletion
        revokes sessions and stops processing immediately. Scheduled cleanup removes the live
        database after a two-minute grace period. A minimal identity tombstone prevents accidental
        account recreation. Anonymous cost totals remain for project budget accounting. Encrypted
        backups expire after the configured retention period (30 days by default). A restored backup
        must have deletion requests reapplied before service resumes.
      </p>
      <h2>Security and limits</h2>
      <p>
        Data is encrypted in transit over HTTPS. The deployment requires encrypted host storage and
        encrypted backups for protection at rest; SQLite itself is not encrypted by this app.
        Operational logs exclude statement contents, prompts, email addresses and secrets. Token and
        cost estimates are stored for quota accounting.
      </p>
      <h2>Questions or account recovery</h2>
      <p>
        Contact the person who invited you to this instance. Passwords, recovery and multi-factor
        authentication are managed by your sign-in provider. This private release supports USD
        expenses and manually recorded repayments.
      </p>
    </main>
  );
}
