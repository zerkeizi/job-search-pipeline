/** Raised when a source answers like it's blocking us (429/403/captcha): stop it until midnight (rule 3). */
export class BlockedError extends Error {}

export interface Http {
  get(url: string): Promise<string>;
}

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

/**
 * Plain GET without credentials or cookies, with a delay before every request after the first
 * and no retries. 429/403 or a captcha page raise BlockedError.
 */
export function politeHttp(delayMs: number, timeoutMs = 30_000, fetchFn: typeof fetch = fetch): Http {
  let first = true;
  return {
    async get(url: string): Promise<string> {
      if (!first) await new Promise((r) => setTimeout(r, delayMs));
      first = false;
      const res = await fetchFn(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json, text/html;q=0.9" },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      const body = await res.text();
      if (res.status === 429 || res.status === 403) throw new BlockedError(`HTTP ${res.status} from ${new URL(url).host}`);
      if (/captcha|cf-chl|are you a robot/i.test(body.slice(0, 5000)) && !body.trimStart().startsWith("{")) {
        throw new BlockedError(`captcha page from ${new URL(url).host}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return body;
    },
  };
}
