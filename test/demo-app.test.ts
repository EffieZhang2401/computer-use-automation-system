import { once } from "node:events";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../demo-app/app";
import {
  DEFAULT_SEARCH_FIELDS,
  DRIFTED_SEARCH_FIELDS,
} from "../demo-app/html";
import { clearInject } from "../demo-app/inject";
import {
  AUTH_COOKIE,
  EXISTING_MEMBER_ID,
  FORBIDDEN_MEMBER_ID,
  LOGIN,
  UNKNOWN_MEMBER_ID,
} from "../demo-app/seed";

class Client {
  cookie = "";

  constructor(private readonly base: string) {}

  async fetch(
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; location: string | null; text: string }> {
    const headers = new Headers(init.headers);
    if (this.cookie !== "") headers.set("cookie", this.cookie);
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers,
      redirect: "manual",
    });
    this.applySetCookie(res.headers.getSetCookie());
    const location = res.headers.get("location");
    const text = await res.text();
    return { status: res.status, location, text };
  }

  async login(): Promise<void> {
    const res = await this.fetch("/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `username=${encodeURIComponent(LOGIN.username)}&password=${encodeURIComponent(LOGIN.password)}`,
    });
    expect(res.status).toBe(302);
    expect(res.location).toBe("/");
  }

  async json(path: string): Promise<unknown> {
    const headers = new Headers();
    if (this.cookie !== "") headers.set("cookie", this.cookie);
    const res = await fetch(`${this.base}${path}`, { headers, redirect: "manual" });
    this.applySetCookie(res.headers.getSetCookie());
    return (await res.json()) as unknown;
  }

  private applySetCookie(setCookie: string[]): void {
    for (const entry of setCookie) {
      const pair = entry.split(";")[0];
      if (pair === undefined) continue;
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const expired = /max-age=0/i.test(entry) || value === "";
      if (name === AUTH_COOKIE && expired) {
        this.cookie = "";
      } else {
        this.cookie = `${name}=${value}`;
      }
    }
  }
}

describe("CoreBank Lite demo app", () => {
  let server!: Server;
  let base: string;

  beforeAll(async () => {
    const app = createApp();
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });
    const addr = server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("demo-app test server did not bind");
    }
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    server.close();
    await once(server, "close");
  });

  beforeEach(() => {
    clearInject();
    delete process.env.DEMO_SLOW_MS;
  });

  it("walks login → search 12345 → balance → sub-account confirmation", async () => {
    const client = new Client(base);
    const unauth = await client.fetch("/members/search");
    expect(unauth.status).toBe(302);
    expect(unauth.location).toBe("/login");

    await client.login();
    const shell = await client.fetch("/");
    expect(shell.status).toBe(200);
    expect(shell.text).toContain('name="content"');
    expect(shell.text).toContain('src="/members/search"');
    expect(shell.text).not.toContain("data-testid");

    const search = await client.fetch("/members/search");
    expect(search.text).toContain(`id="${DEFAULT_SEARCH_FIELDS.inputId}"`);
    expect(search.text).toContain(`name="${DEFAULT_SEARCH_FIELDS.inputName}"`);
    expect(search.text).toContain(`<label for="${DEFAULT_SEARCH_FIELDS.inputId}">Member ID</label>`);
    expect(search.text).toContain(">Search</button>");
    expect(search.text).not.toContain("data-testid");

    const posted = await client.fetch("/members/search", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `memberId=${EXISTING_MEMBER_ID}`,
    });
    expect(posted.status).toBe(302);
    expect(posted.location).toBe(`/members/${EXISTING_MEMBER_ID}`);

    const member = await client.fetch(`/members/${EXISTING_MEMBER_ID}`);
    expect(member.text).toContain("Savings");
    expect(member.text).toContain("$4,210.55");
    expect(member.text).toContain('aria-label="Accounts"');
    expect(member.text).toContain("Open new sub-account");

    const form = await client.fetch(`/members/${EXISTING_MEMBER_ID}/subaccount/new`);
    expect(form.status).toBe(200);
    expect(form.text).toContain("Open New Sub-Account");
    expect(form.text).toContain(`<label for="ctl00$MainContent$ddlProduct">Product</label>`);

    const opened = await client.fetch(`/members/${EXISTING_MEMBER_ID}/subaccount/new`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "product=Money%20Market",
    });
    expect(opened.status).toBe(302);
    expect(opened.location).toBe(
      `/members/${EXISTING_MEMBER_ID}/subaccount/confirm?product=Money%20Market`,
    );

    const confirm = await client.fetch(opened.location ?? "");
    expect(confirm.status).toBe(200);
    expect(confirm.text).toContain("Sub-account confirmation");
    expect(confirm.text).toContain("Money Market");
    expect(confirm.text).toContain("Pending fulfillment");
  });

  it("treats 99999 as not found and 77777 as permission denied", async () => {
    const client = new Client(base);
    await client.login();

    const missing = await client.fetch("/members/search", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `memberId=${UNKNOWN_MEMBER_ID}`,
    });
    expect(missing.status).toBe(200);
    expect(missing.text).toContain("Member not found");

    const forbidden = await client.fetch(`/members/${FORBIDDEN_MEMBER_ID}`);
    expect(forbidden.text).toContain("Permission denied");
  });

  it("applies each inject mode to the expected page state", async () => {
    const client = new Client(base);
    await client.login();

    await client.json("/__test/inject?mode=not_found&once=true&format=json");
    const notFound = await client.fetch("/members/search", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `memberId=${EXISTING_MEMBER_ID}`,
    });
    expect(notFound.text).toContain("Member not found");
    const recovered = await client.fetch("/members/search", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `memberId=${EXISTING_MEMBER_ID}`,
    });
    expect(recovered.status).toBe(302);

    await client.json("/__test/inject?mode=validation&once=true&format=json");
    const validation = await client.fetch("/members/search", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `memberId=${EXISTING_MEMBER_ID}`,
    });
    expect(validation.text).toContain("Invalid Member ID");

    await client.json("/__test/inject?mode=permission_denied&once=true&format=json");
    const denied = await client.fetch("/members/search", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `memberId=${EXISTING_MEMBER_ID}`,
    });
    expect(denied.text).toContain("Permission denied");

    await client.json("/__test/inject?mode=interstitial&once=true&format=json");
    const notice = await client.fetch("/members/search");
    expect(notice.text).toContain("System notice");
    expect(notice.text).toContain(">Dismiss</button>");
    const dismissed = await client.fetch("/__test/dismiss", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "returnUrl=/members/search",
    });
    expect(dismissed.status).toBe(302);
    const afterDismiss = await client.fetch("/members/search");
    expect(afterDismiss.text).not.toContain("System notice");

    process.env.DEMO_SLOW_MS = "40";
    await client.json("/__test/inject?mode=slow&once=true&format=json");
    const started = Date.now();
    const delayed = await client.fetch("/members/search");
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(delayed.status).toBe(200);
    expect(delayed.text).toContain("Member Search");
    delete process.env.DEMO_SLOW_MS;

    await client.json("/__test/inject?mode=session_expired&once=true&format=json");
    const expired = await client.fetch("/members/search");
    expect(expired.status).toBe(302);
    expect(expired.location).toBe("/login?reason=expired");
    const login = await client.fetch(expired.location ?? "/login");
    expect(login.text).toContain("Your session has expired");

    await client.login();
    await client.json("/__test/inject?mode=app_error&once=true&format=json");
    const boom = await client.fetch("/members/search");
    expect(boom.status).toBe(500);
    expect(boom.text).toContain("Application error");
    expect(boom.text).toContain("ERR-CORE-0001");

    await client.json("/__test/inject?mode=locator_drift&once=true&format=json");
    const drifted = await client.fetch("/members/search");
    expect(drifted.text).toContain(`id="${DRIFTED_SEARCH_FIELDS.inputId}"`);
    expect(drifted.text).toContain(`name="${DRIFTED_SEARCH_FIELDS.inputName}"`);
    expect(drifted.text).toContain(`<label for="${DRIFTED_SEARCH_FIELDS.inputId}">Member ID</label>`);
    expect(drifted.text).toContain(">Search</button>");
    expect(drifted.text).not.toContain(`id="${DEFAULT_SEARCH_FIELDS.inputId}"`);
  });
});
