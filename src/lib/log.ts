// Log an allowlisted event schema. Never log request bodies, CSVs, prompts, email, URLs or error messages.
export function log(
  event: string,
  fields: {
    requestId?: string;
    jobId?: string;
    status?: number;
    elapsedMs?: number;
    code?: string;
  } = {},
) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}
