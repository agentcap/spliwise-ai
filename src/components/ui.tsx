'use client';
import { useEffect, useRef, createContext, useContext } from 'react';
import { X } from 'lucide-react';
import { money } from '@/lib/money';
import type { Person, RuleDefinition } from '@/lib/types';
export const ActionErrorContext = createContext<string | null>(null);
export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(
    '/api/' + path,
    body === undefined
      ? { cache: 'no-store' }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Action failed.');
  return d as T;
}
export function ruleDescription(d: RuleDefinition, people: Person[]): string {
  const s = d.split,
    name = (id: string) => people.find((p) => p.id === id)?.name || '?';
  return (
    (s.mode === 'personal'
      ? 'Personal expense'
      : s.mode === 'equal'
        ? 'Equal split: ' + s.participants.map(name).join(', ')
        : s.participants
            .map(
              (id, i) =>
                name(id) +
                ' ' +
                (s.mode === 'percent'
                  ? (s.values?.[i] || 0) / 100 + '%'
                  : money(s.values?.[i] || 0)),
            )
            .join(' · ')) +
    ' · ' +
    d.outputCategory
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    error = useContext(ActionErrorContext);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={'modal ' + (wide ? 'wide' : '')}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-label={title}
    >
      <header className="modal-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close dialog">
          <X size={20} />
        </button>
      </header>
      {error && (
        <p className="notice error modal-error" role="alert">
          {error}
        </p>
      )}
      {children}
    </dialog>
  );
}
