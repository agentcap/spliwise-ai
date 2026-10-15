// Personal workspace default. Override with NEXT_PUBLIC_TIME_ZONE before starting the app.
const timeZone = process.env.NEXT_PUBLIC_TIME_ZONE || 'America/Los_Angeles';
export function displayTime(value: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(new Date(value));
}
