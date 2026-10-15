'use client';
import { useEffect, useId, useRef, useState } from 'react';
import type { Person } from '@/lib/types';

export default function MentionInput({
  value,
  onChange,
  people,
  placeholder,
  label,
  onSubmit,
  disabled = false,
  maxLength = 12000,
  compact = false,
}: {
  value: string;
  onChange: (value: string) => void;
  people: Person[];
  placeholder?: string;
  label: string;
  onSubmit?: () => void;
  disabled?: boolean;
  maxLength?: number;
  compact?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [cursor, setCursor] = useState(value.length);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const before = value.slice(0, cursor);
  const match = /(?:^|\s)@([a-zA-Z0-9_]*)$/.exec(before);
  const choices =
    focused && !dismissed && match
      ? people
          .filter(
            (p) =>
              p.handle.includes(match[1].toLowerCase()) ||
              p.name.toLowerCase().includes(match[1].toLowerCase()),
          )
          .slice(0, 6)
      : [];
  useEffect(() => {
    if (!ref.current) return;
    ref.current.style.height = 'auto';
    ref.current.style.height = Math.min(ref.current.scrollHeight, compact ? 150 : 220) + 'px';
  }, [value, compact]);
  function pick(p: Person) {
    const start = before.lastIndexOf('@');
    const next = value.slice(0, start) + '@' + p.handle + ' ' + value.slice(cursor);
    const pos = start + p.handle.length + 2;
    onChange(next);
    setCursor(pos);
    setActive(0);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });
  }
  return (
    <div className={'mention-wrap' + (compact ? ' compact-mention' : '')}>
      {choices.length > 0 && (
        <div className="mention-options" role="listbox" id={listId} aria-label="Mention a person">
          {choices.map((p, i) => (
            <button
              type="button"
              role="option"
              id={listId + '-' + i}
              aria-selected={i === active % choices.length}
              key={p.id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(p)}
            >
              <span className="avatar small">{p.name[0]}</span>
              <span>
                {p.name}
                <small>
                  @{p.handle}
                  {p.relation ? ' · ' + p.relation : ''}
                </small>
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
        rows={compact ? 2 : 3}
        disabled={disabled}
        maxLength={maxLength}
        aria-controls={choices.length ? listId : undefined}
        aria-expanded={choices.length > 0}
        aria-activedescendant={
          choices.length ? listId + '-' + (active % choices.length) : undefined
        }
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          onChange(e.target.value);
          setCursor(e.target.selectionStart);
          setActive(0);
          setDismissed(false);
        }}
        onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (choices.length) {
            if (e.key === 'Escape') {
              e.preventDefault();
              setDismissed(true);
              return;
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((active + 1) % choices.length);
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((active + choices.length - 1) % choices.length);
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              pick(choices[active % choices.length]);
              return;
            }
          }
          if (e.key === 'Enter' && !e.shiftKey && onSubmit) {
            e.preventDefault();
            if (value.trim() && !disabled) onSubmit();
          }
        }}
      />
    </div>
  );
}
