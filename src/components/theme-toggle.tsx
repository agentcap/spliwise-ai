'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

type Theme = 'dark' | 'light';
const storageKey = 'splitwise-ai-theme';

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    const syncPreference = (event: StorageEvent) => {
      if (event.key !== storageKey && event.key !== null) return;
      const next: Theme = event.newValue === 'light' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      setTheme(next);
    };
    window.addEventListener('storage', syncPreference);
    return () => window.removeEventListener('storage', syncPreference);
  }, []);

  function toggleTheme() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // Switching still works when the browser disables persistent storage.
    }
  }

  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <button
      type="button"
      className="quiet-button theme-toggle"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
    >
      {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      <span className="theme-toggle-label">{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
    </button>
  );
}
