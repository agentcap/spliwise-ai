'use client';
import { useRef, useState } from 'react';
import type { Person } from '@/lib/types';
export default function MentionInput({
  value,
  onChange,
  people,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  people: Person[];
  placeholder?: string;
  label: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null),
    [cursor, setCursor] = useState(value.length),
    [active, setActive] = useState(0);
  const before = value.slice(0, cursor),
    match = /(?:^|\s)@([a-zA-Z0-9_]*)$/.exec(before);
  const choices = match
    ? people
        .filter(
          (p) =>
            p.handle.includes(match[1].toLowerCase()) ||
            p.name.toLowerCase().includes(match[1].toLowerCase()),
        )
        .slice(0, 6)
    : [];
  function pick(p: Person) {
    const start = before.lastIndexOf('@'),
      next = value.slice(0, start) + '@' + p.handle + ' ' + value.slice(cursor),
      pos = start + p.handle.length + 2;
    onChange(next);
    setCursor(pos);
    setActive(0);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });
  }
  return (
    <div className="mention-wrap">
      {choices.length > 0 && (
        <div className="mention-options" role="listbox" aria-label="Mention a person">
          {choices.map((p, i) => (
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              key={p.id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(p)}
            >
              <span className="avatar small">{p.name[0]}</span>
              <span>
                {p.name}
                <small>@{p.handle}</small>
              </span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setCursor(e.target.selectionStart);
          setActive(0);
        }}
        onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
        onKeyDown={(e) => {
          if (!choices.length) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((active + 1) % choices.length);
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((active + choices.length - 1) % choices.length);
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            pick(choices[active % choices.length]);
          }
        }}
      />
    </div>
  );
}
