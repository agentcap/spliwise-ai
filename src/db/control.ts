import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../lib/config';
export interface Principal {
  id: string;
  issuer: string;
  subject: string;
  email: string;
  name: string;
  timezone: string;
  status: string;
  consentAt: string | null;
  createdAt: string;
}
export function openControl(file: string, allowMigration = true): Database.Database {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  if (file !== ':memory:') chmodSync(file, 0o600);
  db.pragma('journal_mode = WAL');
  db.pragma('secure_delete = ON');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const version = db.pragma('user_version', { simple: true }) as number;
  if (!allowMigration && version !== 3) {
    db.close();
    throw new Error('Control database migrations are required before startup.');
  }
  if (version > 3) {
    db.close();
    throw new Error('Control database is newer than this application.');
  }
  if (!version)
    db.transaction(() => {
      db.exec(`
      CREATE TABLE principals (
        id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
        status TEXT NOT NULL DEFAULT 'active', consentAt TEXT, createdAt TEXT NOT NULL,
        UNIQUE(issuer, subject)
      );
      CREATE TABLE sessions (hash TEXT PRIMARY KEY, principalId TEXT NOT NULL REFERENCES principals(id),
        expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX session_expiry ON sessions(expiresAt);
      CREATE TABLE auth_flows (hash TEXT PRIMARY KEY, state TEXT NOT NULL, verifier TEXT NOT NULL,
        nonce TEXT NOT NULL, expiresAt INTEGER NOT NULL);
      CREATE TABLE rates (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expiresAt INTEGER NOT NULL);
      CREATE TABLE ai_usage (id TEXT PRIMARY KEY, principalId TEXT NOT NULL, jobId TEXT,
        model TEXT NOT NULL, month TEXT NOT NULL, status TEXT NOT NULL, reservedMicros INTEGER NOT NULL,
        costMicros INTEGER NOT NULL DEFAULT 0, inputTokens INTEGER NOT NULL DEFAULT 0,
        outputTokens INTEGER NOT NULL DEFAULT 0, inputPrice REAL NOT NULL, outputPrice REAL NOT NULL,
        responseId TEXT, createdAt TEXT NOT NULL);
      CREATE INDEX usage_month ON ai_usage(month, principalId);
      CREATE TABLE worker_status (id TEXT PRIMARY KEY, heartbeat INTEGER NOT NULL);
      PRAGMA user_version = 1;
    `);
    }).immediate();
  if (version < 2)
    db.transaction(() => {
      db.exec('ALTER TABLE worker_status ADD COLUMN owner TEXT; PRAGMA user_version = 2;');
    }).immediate();
  if (version < 3)
    db.transaction(() => {
      db.exec('ALTER TABLE principals ADD COLUMN deletionAt INTEGER; PRAGMA user_version = 3;');
    }).immediate();
  return db;
}
let singleton: Database.Database | undefined;
export function controlDb() {
  return (singleton ??= openControl(config().controlPath, !config().production));
}
