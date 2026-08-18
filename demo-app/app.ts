import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import {
  clearIf,
  clearInject,
  getInject,
  isInjectMode,
  setInject,
  slowDelayMs,
  takeInject,
  type InjectMode,
} from "./inject";
import {
  renderAppError,
  renderInjectStatus,
  renderLogin,
  renderMember,
  renderMemberNotFound,
  renderPageNotFound,
  renderPermissionDenied,
  renderSearch,
  renderShell,
  renderSubaccountConfirm,
  renderSubaccountNew,
} from "./html";
import {
  AUTH_COOKIE,
  AUTH_COOKIE_VALUE,
  FORBIDDEN_MEMBER_ID,
  LOGIN,
  MEMBERS,
  SUBACCOUNT_PRODUCTS,
  type Member,
} from "./seed";

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function parseOnce(value: unknown): boolean {
  const raw = firstString(value);
  if (raw === undefined) return true;
  return raw !== "false" && raw !== "0";
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key !== name) continue;
    return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

function isAuthenticated(req: Request): boolean {
  return readCookie(req, AUTH_COOKIE) === AUTH_COOKIE_VALUE;
}

function setAuthCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${AUTH_COOKIE}=${AUTH_COOKIE_VALUE}; Path=/; HttpOnly; SameSite=Lax`);
}

function clearAuthCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthenticated(req)) {
    next();
    return;
  }
  res.redirect("/login");
}

async function applyGlobalInject(_req: Request, res: Response, next: NextFunction): Promise<void> {
  const mode = takeInject("slow", "session_expired", "app_error");
  if (mode === "slow") {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, slowDelayMs());
    });
    next();
    return;
  }
  if (mode === "session_expired") {
    clearAuthCookie(res);
    res.redirect("/login?reason=expired");
    return;
  }
  if (mode === "app_error") {
    res.status(500).type("html").send(renderAppError());
    return;
  }
  next();
}

function readMemberId(body: unknown): string {
  if (body === null || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  const keys = [
    "memberId",
    "memNo",
    "ctl00$MainContent$txtMemberId",
    "ctl00$ContentPlaceHolder1$txtMemNo",
  ];
  for (const key of keys) {
    const value = firstString(record[key]);
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return "";
}

function safeReturnUrl(value: string | undefined, fallback: string): string {
  if (value === undefined || !value.startsWith("/") || value.startsWith("//")) return fallback;
  return value;
}

type MemberLookup =
  | { kind: "ok"; member: Member }
  | { kind: "not_found" }
  | { kind: "validation" }
  | { kind: "permission_denied" };

function lookupMember(memberId: string, forced: InjectMode | null): MemberLookup {
  if (forced === "validation") return { kind: "validation" };
  if (forced === "not_found") return { kind: "not_found" };
  if (forced === "permission_denied") return { kind: "permission_denied" };
  if (memberId === "") return { kind: "validation" };
  if (!/^\d+$/.test(memberId)) return { kind: "validation" };
  if (memberId === FORBIDDEN_MEMBER_ID) return { kind: "permission_denied" };
  const member = MEMBERS[memberId];
  if (member === undefined) return { kind: "not_found" };
  return { kind: "ok", member };
}

function wantsJson(req: Request): boolean {
  const format = firstString(req.query.format);
  if (format === "json") return true;
  const accept = req.headers.accept ?? "";
  return accept.includes("application/json") && !accept.includes("text/html");
}

function isSubaccountProduct(value: string): value is (typeof SUBACCOUNT_PRODUCTS)[number] {
  return (SUBACCOUNT_PRODUCTS as readonly string[]).includes(value);
}

function sendMemberError(
  res: Response,
  result: Exclude<MemberLookup, { kind: "ok" }>,
  opts: { interstitial?: boolean; returnUrl?: string },
): void {
  if (result.kind === "validation") {
    res.type("html").send(
      renderSearch({
        alert: "Invalid Member ID",
        interstitial: opts.interstitial,
        returnUrl: opts.returnUrl ?? "/members/search",
      }),
    );
    return;
  }
  if (result.kind === "not_found") {
    res.status(200).type("html").send(renderMemberNotFound(opts));
    return;
  }
  res.status(200).type("html").send(renderPermissionDenied(opts));
}

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false }));

  app.get("/__test/inject", (req, res) => {
    const modeRaw = firstString(req.query.mode);
    const once = parseOnce(req.query.once);

    if (modeRaw === undefined || modeRaw === "") {
      const pending = getInject();
      const payload = {
        ok: true as const,
        mode: pending?.mode ?? null,
        once: pending?.once ?? null,
      };
      if (wantsJson(req)) {
        res.json(payload);
        return;
      }
      res.type("html").send(renderInjectStatus(payload));
      return;
    }

    if (modeRaw === "clear") {
      clearInject();
      const payload = { ok: true as const, mode: null, once: null };
      if (wantsJson(req)) {
        res.json(payload);
        return;
      }
      res.type("html").send(renderInjectStatus(payload));
      return;
    }

    if (!isInjectMode(modeRaw)) {
      const payload = {
        ok: false as const,
        mode: null,
        once: null,
        error: `Unknown mode: ${modeRaw}`,
      };
      res.status(400);
      if (wantsJson(req)) {
        res.json(payload);
        return;
      }
      res.type("html").send(renderInjectStatus(payload));
      return;
    }

    setInject(modeRaw, once);
    const payload = { ok: true as const, mode: modeRaw, once };
    if (wantsJson(req)) {
      res.json(payload);
      return;
    }
    res.type("html").send(renderInjectStatus(payload));
  });

  app.post("/__test/dismiss", (req, res) => {
    clearIf("interstitial");
    const body = req.body as Record<string, unknown>;
    const returnUrl = safeReturnUrl(firstString(body.returnUrl), "/members/search");
    res.redirect(returnUrl);
  });

  app.get("/login", (req, res) => {
    if (isAuthenticated(req)) {
      res.redirect("/");
      return;
    }
    const expired = firstString(req.query.reason) === "expired";
    res.type("html").send(renderLogin({ expired }));
  });

  app.post("/login", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const username = firstString(body.username) ?? "";
    const password = firstString(body.password) ?? "";
    if (username === LOGIN.username && password === LOGIN.password) {
      setAuthCookie(res);
      res.redirect("/");
      return;
    }
    res.status(401).type("html").send(renderLogin({ error: "Invalid username or password." }));
  });

  app.get("/logout", (_req, res) => {
    clearAuthCookie(res);
    res.redirect("/login");
  });

  app.get("/", requireAuth, applyGlobalInject, (_req, res) => {
    res.type("html").send(renderShell());
  });

  app.get("/members/search", requireAuth, applyGlobalInject, (req, res) => {
    const mode = takeInject("interstitial", "locator_drift");
    res.type("html").send(
      renderSearch({
        interstitial: mode === "interstitial",
        locatorDrift: mode === "locator_drift",
        returnUrl: req.originalUrl,
      }),
    );
  });

  app.post("/members/search", requireAuth, applyGlobalInject, (req, res) => {
    const mode = takeInject(
      "not_found",
      "validation",
      "permission_denied",
      "interstitial",
      "locator_drift",
    );
    const memberId = readMemberId(req.body);
    const interstitial = mode === "interstitial";
    const locatorDrift = mode === "locator_drift";
    if (
      memberId === "" &&
      mode !== "validation" &&
      mode !== "not_found" &&
      mode !== "permission_denied"
    ) {
      res.type("html").send(
        renderSearch({
          alert: "Member ID is required",
          interstitial,
          locatorDrift,
          returnUrl: "/members/search",
        }),
      );
      return;
    }
    const result = lookupMember(memberId, mode);
    if (result.kind === "ok") {
      res.redirect(`/members/${encodeURIComponent(result.member.memberId)}`);
      return;
    }
    if (result.kind === "validation") {
      res.type("html").send(
        renderSearch({
          alert: "Invalid Member ID",
          interstitial,
          locatorDrift,
          returnUrl: "/members/search",
        }),
      );
      return;
    }
    sendMemberError(res, result, { interstitial, returnUrl: "/members/search" });
  });

  app.get("/members/:id/subaccount/new", requireAuth, applyGlobalInject, (req, res) => {
    const memberId = firstString(req.params.id) ?? "";
    const mode = takeInject("not_found", "permission_denied", "validation", "interstitial");
    const result = lookupMember(memberId, mode);
    if (result.kind !== "ok") {
      sendMemberError(res, result, {
        interstitial: mode === "interstitial",
        returnUrl: req.originalUrl,
      });
      return;
    }
    res.type("html").send(
      renderSubaccountNew(result.member.memberId, {
        interstitial: mode === "interstitial",
        returnUrl: req.originalUrl,
      }),
    );
  });

  app.post("/members/:id/subaccount/new", requireAuth, applyGlobalInject, (req, res) => {
    const memberId = firstString(req.params.id) ?? "";
    const mode = takeInject("not_found", "permission_denied", "validation", "interstitial");
    const result = lookupMember(memberId, mode);
    if (result.kind !== "ok") {
      sendMemberError(res, result, {
        interstitial: mode === "interstitial",
        returnUrl: req.originalUrl,
      });
      return;
    }
    const product = firstString((req.body as Record<string, unknown>).product) ?? "";
    if (!isSubaccountProduct(product)) {
      res.type("html").send(
        renderSubaccountNew(result.member.memberId, {
          error: "Product is required",
          interstitial: mode === "interstitial",
          returnUrl: req.originalUrl,
        }),
      );
      return;
    }
    res.redirect(
      `/members/${encodeURIComponent(result.member.memberId)}/subaccount/confirm?product=${encodeURIComponent(product)}`,
    );
  });

  app.get("/members/:id/subaccount/confirm", requireAuth, applyGlobalInject, (req, res) => {
    const memberId = firstString(req.params.id) ?? "";
    const mode = takeInject("not_found", "permission_denied", "validation", "interstitial");
    const result = lookupMember(memberId, mode);
    if (result.kind !== "ok") {
      sendMemberError(res, result, {
        interstitial: mode === "interstitial",
        returnUrl: req.originalUrl,
      });
      return;
    }
    const product = firstString(req.query.product) ?? "";
    if (!isSubaccountProduct(product)) {
      res.redirect(`/members/${encodeURIComponent(result.member.memberId)}/subaccount/new`);
      return;
    }
    res.type("html").send(
      renderSubaccountConfirm(result.member.memberId, product, {
        interstitial: mode === "interstitial",
        returnUrl: req.originalUrl,
      }),
    );
  });

  app.get("/members/:id", requireAuth, applyGlobalInject, (req, res) => {
    const memberId = firstString(req.params.id) ?? "";
    const mode = takeInject("not_found", "permission_denied", "validation", "interstitial");
    const result = lookupMember(memberId, mode);
    if (result.kind === "ok") {
      res.type("html").send(
        renderMember(result.member, {
          interstitial: mode === "interstitial",
          returnUrl: req.originalUrl,
        }),
      );
      return;
    }
    sendMemberError(res, result, {
      interstitial: mode === "interstitial",
      returnUrl: req.originalUrl,
    });
  });

  app.use((_req, res) => {
    res.status(404).type("html").send(renderPageNotFound());
  });

  return app;
}
