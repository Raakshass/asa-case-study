/**
 * The safe sender of Automations (plan A5): one HTTPS POST to a host the operator allowed, and nothing else. Called by the
 * engine for webhook and chat steps (as a `Sender`, with two arguments); the engine owns retries, so a test can count
 * attempts. It is the only code in the app that talks to a server it does not own, which is why it is strict:
 *
 *  - off unless AUTOMATION_ALLOWED_HOSTS lists the host (`hooks.slack.com`, or `*.example.com` for any subdomain);
 *  - https on port 443 only, no user name or password in the URL, no redirects followed;
 *  - the host is resolved, EVERY address must be public (a block list of private, loopback, link-local, carrier-grade,
 *    documentation, multicast and transition ranges), and the connection is PINNED to the vetted address, so a DNS
 *    answer that changes between the check and the connection (rebinding) is never used;
 *  - an IP address written in the URL is checked against the same block list without any lookup, so a numeric or hex
 *    form of 127.0.0.1 cannot get through;
 *  - the whole attempt has a deadline (a socket idle timeout would let a server that drips bytes hold it open);
 *  - at most 64 KB of the answer is read, and only a few hundred characters of it are kept as text.
 *
 * Every refusal is a fixed sentence: the sender never puts an exception message, which can echo the host (and a host
 * can carry a secret), into `error`, and logs only status, time and whether it can be retried. Server-only.
 */
import crypto from "node:crypto";
import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import { CONFIG } from "../config";

export interface OutboundRequest {
  url: string;
  body: string;
  signingSecret: string | null;
  now: Date;
}
export interface OutboundResponse {
  ok: boolean;
  status: number;
  bodyText: string;
  error: string | null;
  retryable: boolean;
}
export type Sender = (req: OutboundRequest, allowedHosts: readonly string[]) => Promise<OutboundResponse>;
type Resolve = (host: string, opts: { all: true; verbatim: true }) => Promise<{ address: string; family: number }[]>;
type RequestFn = typeof https.request;

const MAX_RESPONSE_BYTES = 64 * 1024;
const PRIVATE_ADDRESS = "The webhook host points to a private or reserved address.";

/* ---- the address block list ---- */

const BLOCKED = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
] as const) {
  BLOCKED.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 96], // IPv4-compatible, which includes :: and ::1
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48],
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  BLOCKED.addSubnet(address, prefix, "ipv6");
}

/** The eight 16-bit groups of an IPv6 address (a dotted IPv4 tail allowed), or null when it is not one. */
function ipv6Groups(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const part = (h: string): string[] => (h === "" ? [] : h.split(":"));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const last = (tail.length > 0 ? tail : head).slice(-1)[0] ?? "";
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(last);
  if (v4) {
    const n = v4.slice(1).map(Number);
    if (n.some((x) => x > 255)) return null;
    const list = tail.length > 0 ? tail : head;
    list.splice(list.length - 1, 1, ((n[0] << 8) | n[1]).toString(16), ((n[2] << 8) | n[3]).toString(16));
  }
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => Number.parseInt(g, 16));
}

/** True when the address is in a private or reserved range. An IPv4-mapped IPv6 address is judged by the IPv4 inside it. */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return BLOCKED.check(address, "ipv4");
  if (family !== 6) return true; // not an address at all: never connect
  const groups = ipv6Groups(address);
  if (groups === null) return true;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return BLOCKED.check(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`, "ipv4");
  }
  return BLOCKED.check(groups.map((g) => g.toString(16)).join(":"), "ipv6");
}

/** Does `host` match an allowed entry: the same name, or any subdomain of `*.suffix` (the dot is kept, so evilslack.com never matches *.slack.com). */
export function hostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  return allowedHosts.some((raw) => {
    const e = raw.trim().toLowerCase().replace(/\.+$/, "");
    return e !== "" && (host === e || (e.startsWith("*.") && host.endsWith(e.slice(1)) && host.length > e.length - 1));
  });
}

/** "sha256=<hex HMAC-SHA256(secret, `${ts}.${body}`)>". The timestamp is inside the signature, so a captured request cannot be replayed with a new one. */
export function signPayload(secret: string, ts: number, body: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
}

const refuse = (error: string): OutboundResponse => ({ ok: false, status: 0, bodyText: "", error, retryable: false });
const stripControl = (text: string): string => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

function logSend(status: number, startedAt: number, retryable: boolean): void {
  console.log(JSON.stringify({ event: "automation_send", status, ms: Date.now() - startedAt, retryable }));
}

/**
 * One POST. The two extra parameters exist only for tests (a fake resolver and a fake `https.request`); the engine calls
 * it with two arguments, as a Sender.
 */
export async function sendHttps(
  req: OutboundRequest,
  allowedHosts: readonly string[],
  resolve: Resolve = dns.promises.lookup as unknown as Resolve,
  request: RequestFn = https.request,
): Promise<OutboundResponse> {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return refuse("The webhook URL is not a valid URL.");
  }
  if (url.protocol !== "https:") return refuse("Only https:// webhook URLs are allowed.");
  if (url.username !== "" || url.password !== "") return refuse("The webhook URL must not contain a user name or password.");
  if (url.port !== "" && url.port !== "443") return refuse("Only the standard https port (443) is allowed.");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const bare = host.replace(/^\[|\]$/g, "");
  const literal = net.isIP(bare) !== 0;
  if (literal && isBlockedAddress(bare)) return refuse(PRIVATE_ADDRESS);
  if (allowedHosts.length === 0) return refuse("Sending to other servers is turned off on this server (AUTOMATION_ALLOWED_HOSTS is empty).");
  if (!hostAllowed(host, allowedHosts)) return refuse(`${host} is not in this server's list of allowed webhook hosts.`);

  let addresses: { address: string; family: number }[];
  if (literal) addresses = [{ address: bare, family: net.isIP(bare) }];
  else {
    try {
      addresses = await resolve(host, { all: true, verbatim: true });
    } catch {
      return refuse("The webhook host could not be found.");
    }
  }
  if (addresses.length === 0) return refuse("The webhook host could not be found.");
  if (addresses.some((a) => isBlockedAddress(a.address))) return refuse(PRIVATE_ADDRESS);
  const { address, family } = addresses[0];

  const ts = Math.floor(req.now.getTime() / 1000);
  const headers: Record<string, string | number> = {
    "content-type": "application/json",
    "user-agent": "invoice-ap-automations/1",
    "content-length": Buffer.byteLength(req.body),
  };
  if (req.signingSecret !== null && req.signingSecret !== "") {
    headers["x-invoice-ap-timestamp"] = String(ts);
    headers["x-invoice-ap-signature"] = signPayload(req.signingSecret, ts, req.body);
  }
  // The connection goes to the vetted address whatever the name resolves to now (no DNS rebinding between check and connect).
  const lookup = (_hostname: string, options: unknown, callback: (...args: unknown[]) => void): void => {
    if (typeof options === "object" && options !== null && (options as { all?: boolean }).all === true) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };

  const startedAt = Date.now();
  return await new Promise<OutboundResponse>((done) => {
    let settled = false;
    let timedOut = false;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (r: OutboundResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      logSend(r.status, startedAt, r.retryable);
      done(r);
    };
    const failed = (): OutboundResponse =>
      timedOut
        ? { ok: false, status: 0, bodyText: "", error: "The webhook did not answer within 10 seconds.", retryable: true }
        : { ok: false, status: 0, bodyText: "", error: "The webhook could not be reached.", retryable: true };
    const answer = (status: number, text: string): OutboundResponse => {
      if (status >= 200 && status < 300) return { ok: true, status, bodyText: text, error: null, retryable: false };
      if (status >= 300 && status < 400) return { ok: false, status, bodyText: text, error: "The webhook answered with a redirect, which is not followed.", retryable: false };
      return { ok: false, status, bodyText: text, error: `The webhook answered ${status}.`, retryable: status === 429 || status >= 500 };
    };
    try {
      const out = request(
        { method: "POST", hostname: host, servername: host, path: url.pathname + url.search, port: 443, autoSelectFamily: false, lookup, headers } as https.RequestOptions,
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const status = res.statusCode ?? 0;
          const text = (): string => stripControl(Buffer.concat(chunks).toString("utf8")).slice(0, CONFIG.automationResponseKeepChars);
          res.on("data", (chunk: Buffer) => {
            if (settled) return;
            const room = MAX_RESPONSE_BYTES - size;
            if (room > 0) chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
            size += chunk.length;
            if (size >= MAX_RESPONSE_BYTES) {
              res.destroy();
              finish(answer(status, text()));
            }
          });
          res.on("end", () => finish(answer(status, text())));
          res.on("error", () => finish(failed()));
        },
      );
      deadline = setTimeout(() => {
        timedOut = true;
        finish(failed());
        out.destroy(new Error("deadline"));
      }, CONFIG.automationStepTimeoutMs);
      out.on("error", () => finish(failed()));
      out.end(req.body);
    } catch {
      finish(failed());
    }
  });
}
sendHttps satisfies Sender;
