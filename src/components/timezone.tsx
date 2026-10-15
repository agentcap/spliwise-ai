'use client';
import { ActionErrorContext } from './ui';
import { createContext, useContext } from 'react';
export const TimeZoneContext = createContext('America/Los_Angeles');
export function useDisplayTime() {
  const timeZone = useContext(TimeZoneContext);
  return (value: string, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(new Date(value));
}

export function WorkspaceProviders({
  children,
  timeZone,
  error,
}: {
  children: React.ReactNode;
  timeZone: string;
  error: string | null;
}) {
  return (
    <ActionErrorContext.Provider value={error}>
      <TimeZoneContext.Provider value={timeZone}>{children}</TimeZoneContext.Provider>
    </ActionErrorContext.Provider>
  );
}
