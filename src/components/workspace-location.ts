'use client';
import { useEffect, useRef } from 'react';
export type WorkspaceLocation = {
  view: string;
  from: string;
  to: string;
  search: string;
  person: string;
  account: string;
  trip: string;
  page: number;
};
const views = [
  'assistant',
  'overview',
  'review',
  'finalized',
  'people',
  'rules',
  'imports',
  'trips',
];
export function normalizeLocation(input: Partial<WorkspaceLocation>): WorkspaceLocation {
  const date = (s: unknown) =>
    typeof s === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
      ? s
      : '';
  const text = (s: unknown) => (typeof s === 'string' ? s.slice(0, 200) : '');
  return {
    view: views.includes(input.view || '') ? input.view! : 'assistant',
    from: date(input.from),
    to: date(input.to),
    search: text(input.search),
    person: text(input.person),
    account: text(input.account),
    trip: text(input.trip),
    page:
      Number.isInteger(input.page) && input.page! >= 0 && input.page! <= 1_000_000
        ? input.page!
        : 0,
  };
}
const fields = ['view', 'from', 'to', 'search', 'person', 'account', 'trip', 'page'] as const;
const encode = (state: WorkspaceLocation) => {
  const q = new URLSearchParams();
  for (const key of fields) if (state[key]) q.set(key, String(state[key]));
  return q.toString();
};
export function useWorkspaceLocation(
  state: WorkspaceLocation,
  restore: (s: WorkspaceLocation) => void,
) {
  const initialized = useRef(false),
    target = useRef<string | null>(null),
    previous = useRef('');
  const serialized = encode(state);
  useEffect(() => {
    const read = () => {
      const q = new URLSearchParams(window.location.search);
      const next = normalizeLocation({
        view: q.get('view') || 'assistant',
        from: q.get('from') || '',
        to: q.get('to') || '',
        search: q.get('search') || '',
        person: q.get('person') || '',
        account: q.get('account') || '',
        trip: q.get('trip') || '',
        page: Number(q.get('page')) || 0,
      });
      target.current = encode(next);
      restore(next);
      previous.current = window.location.search.slice(1);
    };
    if (window.location.search) read();
    initialized.current = true;
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, [restore]);
  useEffect(() => {
    if (!initialized.current) return;
    if (target.current !== null) {
      if (serialized === target.current) target.current = null;
      return;
    }
    if (serialized === previous.current) return;
    const old = new URLSearchParams(previous.current),
      next = new URLSearchParams(serialized);
    const method =
      old.get('view') !== next.get('view') || old.get('trip') !== next.get('trip')
        ? 'pushState'
        : 'replaceState';
    window.history[method](null, '', '/?' + serialized);
    previous.current = serialized;
  }, [serialized]);
}
