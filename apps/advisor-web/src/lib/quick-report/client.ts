// Talks to the quick report endpoints of the backend (apps/api: /api/quick-report/check and /run). "check" only reads; "run" is called only with a
// request that next-steps.ts built after the consultant chose an option. Every call throws an Error with a message that can be shown.
import { API_BASE } from "@/lib/api-base";
import type { CheckInfo, RunResult } from "./next-steps";
import type { TestRunResult } from "./test-run";

async function post<T>(path: string, body: unknown, fallback: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error(fallback);
  }
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(fallback);
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : fallback);
  return data as T;
}

export const checkDesign = (design: string, fallback: string) => post<CheckInfo>("/api/quick-report/check", { design }, fallback);

export const runOption = (request: unknown, fallback: string) => post<RunResult>("/api/quick-report/run", request, fallback);

// the test run of a report that exists in IFS: only with a request that test-run.ts built after the consultant confirmed it
export const testRun = (request: unknown, fallback: string) => post<TestRunResult>("/api/quick-report/test", request, fallback);
