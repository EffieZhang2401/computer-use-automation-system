/**
 * Server-rendered HTML for CoreBank Lite.
 * Deliberately legacy: nested tables, ASP.NET-shaped IDs, no data-testid.
 * Interactive elements keep native roles and accessible names via <label>/<button>.
 */
import {
  APP_NAME,
  APP_VERSION,
  EXISTING_MEMBER_ID,
  FORBIDDEN_MEMBER_ID,
  LOGIN,
  SUBACCOUNT_PRODUCTS,
  UNKNOWN_MEMBER_ID,
  VIEWSTATE,
  type Member,
} from "./seed";
import { INJECT_MODES, type InjectMode } from "./inject";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLES = `
html, body { margin: 0; height: 100%; }
body { font-family: Tahoma, Verdana, sans-serif; font-size: 12px; background: #e8e8e0; color: #222; }
a { color: #1a3a5c; }
.header { background: #1a3a5c; color: #fff; padding: 8px 12px; font-size: 16px; font-weight: bold; }
.header small { font-weight: normal; font-size: 11px; margin-left: 8px; color: #c5d4e4; }
.nav { background: #d4d0c8; border-right: 1px solid #808080; padding: 8px; width: 180px; vertical-align: top; }
.nav a { display: block; padding: 4px 2px; text-decoration: none; color: #1a3a5c; }
.content { background: #fff; padding: 12px; vertical-align: top; }
fieldset { border: 1px solid #808080; padding: 8px 10px; }
legend { font-weight: bold; color: #1a3a5c; }
input[type="text"], input[type="password"], select {
  border: 1px solid #7a7a7a; font-family: Tahoma, sans-serif; font-size: 12px; padding: 2px 4px;
}
button, input[type="submit"] {
  font-family: Tahoma, sans-serif; font-size: 12px; padding: 2px 12px;
  background: #ece9d8; border: 1px solid #808080;
}
table.grid { border-collapse: collapse; }
table.grid td, table.grid th { border: 1px solid #a0a0a0; padding: 4px 10px; }
table.grid th { background: #d4d0c8; text-align: left; }
.alert { color: #7a0000; font-weight: bold; margin: 8px 0; }
.notice { background: #fff8dc; border: 2px solid #c4a000; padding: 10px; margin-bottom: 12px; }
.hint { color: #555; margin-top: 16px; }
iframe.main { width: 100%; height: 100%; border: 0; background: #fff; }
table.shell { width: 100%; height: 100%; border-collapse: collapse; }
`.trim();

function viewStateField(): string {
  return `<input type="hidden" name="__VIEWSTATE" value="${VIEWSTATE}" />`;
}

function interstitialBanner(returnUrl: string): string {
  return `
<div class="notice" role="alertdialog" aria-labelledby="ctl00_notice_title" aria-modal="true">
  <table border="0" cellpadding="4" cellspacing="0" width="100%">
    <tr>
      <td>
        <strong id="ctl00_notice_title">System notice</strong>
        <p>A system notice requires your attention before continuing.</p>
        <form method="post" action="/__test/dismiss">
          <input type="hidden" name="returnUrl" value="${escapeHtml(returnUrl)}" />
          <button type="submit" id="ctl00$MainContent$btnDismiss">Dismiss</button>
        </form>
      </td>
    </tr>
  </table>
</div>`.trim();
}

function contentDocument(title: string, body: string, opts?: { interstitial?: boolean; returnUrl?: string }): string {
  const notice =
    opts?.interstitial === true ? interstitialBanner(opts.returnUrl ?? "/members/search") : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)} — ${APP_NAME}</title>
  <style>${STYLES}</style>
</head>
<body>
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td class="header">${APP_NAME} <small>v${APP_VERSION}</small></td>
    </tr>
    <tr>
      <td class="content">
        ${notice}
        ${body}
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function renderLogin(opts?: { error?: string; expired?: boolean }): string {
  const alerts: string[] = [];
  if (opts?.expired === true) {
    alerts.push(`<p class="alert" role="alert">Your session has expired. Please log in again.</p>`);
  }
  if (opts?.error !== undefined) {
    alerts.push(`<p class="alert" role="alert">${escapeHtml(opts.error)}</p>`);
  }
  const body = `
<fieldset>
  <legend>Teller sign-on</legend>
  ${alerts.join("")}
  <form method="post" action="/login">
    ${viewStateField()}
    <table cellpadding="4" cellspacing="0">
      <tr>
        <td><label for="ctl00$Login$txtUsername">Username</label></td>
        <td><input type="text" id="ctl00$Login$txtUsername" name="username" /></td>
      </tr>
      <tr>
        <td><label for="ctl00$Login$txtPassword">Password</label></td>
        <td><input type="password" id="ctl00$Login$txtPassword" name="password" /></td>
      </tr>
      <tr>
        <td></td>
        <td><button type="submit" id="ctl00$Login$btnLogin">Log in</button></td>
      </tr>
    </table>
  </form>
</fieldset>
<p class="hint">
  Authorized teller access only.<br />
  Username: ${escapeHtml(LOGIN.username)} &nbsp; Password: ${escapeHtml(LOGIN.password)}<br />
  Known member: ${EXISTING_MEMBER_ID} &nbsp; unknown: ${UNKNOWN_MEMBER_ID} &nbsp; restricted: ${FORBIDDEN_MEMBER_ID}<br />
  <a href="/__test/inject">Test injects</a>
</p>`;
  return contentDocument("Log in", body);
}

export function renderShell(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${APP_NAME}</title>
  <style>${STYLES}</style>
</head>
<body>
  <table class="shell" cellpadding="0" cellspacing="0">
    <tr>
      <td class="header" colspan="2">${APP_NAME} <small>v${APP_VERSION} — teller workstation</small></td>
    </tr>
    <tr>
      <td class="nav">
        <strong>Navigation</strong>
        <a href="/members/search" target="content">Member Search</a>
        <a href="/__test/inject" target="_top">Test injects</a>
        <a href="/logout" target="_top">Log out</a>
      </td>
      <td>
        <iframe class="main" name="content" id="content" title="Main content" src="/members/search"></iframe>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export type SearchFieldIds = {
  inputId: string;
  inputName: string;
  buttonId: string;
};

export const DEFAULT_SEARCH_FIELDS: SearchFieldIds = {
  inputId: "ctl00$MainContent$txtMemberId",
  inputName: "memberId",
  buttonId: "ctl00$MainContent$btnSearch",
};

export const DRIFTED_SEARCH_FIELDS: SearchFieldIds = {
  inputId: "ctl00$ContentPlaceHolder1$txtMemNo",
  inputName: "memNo",
  buttonId: "ctl00$ContentPlaceHolder1$btnFind",
};

export function renderSearch(opts?: {
  alert?: string;
  interstitial?: boolean;
  locatorDrift?: boolean;
  returnUrl?: string;
}): string {
  const fields = opts?.locatorDrift === true ? DRIFTED_SEARCH_FIELDS : DEFAULT_SEARCH_FIELDS;
  const driftComment =
    opts?.locatorDrift === true ? "<!-- id remap: txtMemberId -> txtMemNo -->" : "";
  const alert =
    opts?.alert !== undefined
      ? `<p class="alert" role="alert">${escapeHtml(opts.alert)}</p>`
      : "";
  const body = `
${driftComment}
<fieldset>
  <legend>Member Search</legend>
  ${alert}
  <form method="post" action="/members/search">
    ${viewStateField()}
    <table cellpadding="4" cellspacing="0">
      <tr>
        <td><label for="${escapeHtml(fields.inputId)}">Member ID</label></td>
        <td>
          <input type="text" id="${escapeHtml(fields.inputId)}" name="${escapeHtml(fields.inputName)}" />
        </td>
      </tr>
      <tr>
        <td></td>
        <td>
          <button type="submit" id="${escapeHtml(fields.buttonId)}">Search</button>
        </td>
      </tr>
    </table>
  </form>
</fieldset>`;
  return contentDocument("Member Search", body, {
    interstitial: opts?.interstitial,
    returnUrl: opts?.returnUrl ?? "/members/search",
  });
}

export function renderMember(member: Member, opts?: { interstitial?: boolean; returnUrl?: string }): string {
  const rows = member.accounts
    .map(
      (account) => `
      <tr>
        <td>${escapeHtml(account.type)}</td>
        <td>${escapeHtml(account.balance)}</td>
      </tr>`,
    )
    .join("");
  const body = `
<h1>Member ${escapeHtml(member.memberId)}</h1>
<p>${escapeHtml(member.name)}</p>
<table class="grid" id="ctl00$MainContent$grdAccounts" aria-label="Accounts">
  <caption>Accounts</caption>
  <tr>
    <th>Account</th>
    <th>Balance</th>
  </tr>
  ${rows}
</table>
<p>
  <a href="/members/${escapeHtml(member.memberId)}/subaccount/new" id="ctl00$MainContent$lnkNewSubAccount">Open new sub-account</a>
</p>
<p>
  <a href="/members/search">Back to search</a>
</p>`;
  return contentDocument(`Member ${member.memberId}`, body, {
    interstitial: opts?.interstitial,
    returnUrl: opts?.returnUrl ?? `/members/${member.memberId}`,
  });
}

export function renderMemberNotFound(opts?: { interstitial?: boolean; returnUrl?: string }): string {
  const body = `
<h1>Member not found</h1>
<p>No member exists for the given identifier.</p>
<p><a href="/members/search">Back to search</a></p>`;
  return contentDocument("Member not found", body, opts);
}

export function renderPermissionDenied(opts?: { interstitial?: boolean; returnUrl?: string }): string {
  const body = `
<h1>Permission denied</h1>
<p>You do not have permission to access this member.</p>
<p><a href="/members/search">Back to search</a></p>`;
  return contentDocument("Permission denied", body, opts);
}

export function renderAppError(): string {
  const body = `
<h1>Application error</h1>
<p>An unexpected error occurred in ${APP_NAME}.</p>
<p>Error code: ERR-CORE-0001</p>`;
  return contentDocument("Application error", body);
}

export function renderSubaccountNew(
  memberId: string,
  opts?: { error?: string; interstitial?: boolean; returnUrl?: string },
): string {
  const options = SUBACCOUNT_PRODUCTS.map(
    (product) => `<option value="${escapeHtml(product)}">${escapeHtml(product)}</option>`,
  ).join("");
  const alert =
    opts?.error !== undefined ? `<p class="alert" role="alert">${escapeHtml(opts.error)}</p>` : "";
  const body = `
<h1>Open New Sub-Account</h1>
<p>Member ${escapeHtml(memberId)}</p>
${alert}
<form method="post" action="/members/${escapeHtml(memberId)}/subaccount/new">
  ${viewStateField()}
  <table cellpadding="4" cellspacing="0">
    <tr>
      <td><label for="ctl00$MainContent$ddlProduct">Product</label></td>
      <td>
        <select id="ctl00$MainContent$ddlProduct" name="product" aria-label="Product">
          ${options}
        </select>
      </td>
    </tr>
    <tr>
      <td></td>
      <td>
        <button type="submit" id="ctl00$MainContent$btnOpen">Submit</button>
      </td>
    </tr>
  </table>
</form>
<p><a href="/members/${escapeHtml(memberId)}">Back to member</a></p>`;
  return contentDocument("Open New Sub-Account", body, {
    interstitial: opts?.interstitial,
    returnUrl: opts?.returnUrl ?? `/members/${memberId}/subaccount/new`,
  });
}

export function renderSubaccountConfirm(
  memberId: string,
  product: string,
  opts?: { interstitial?: boolean; returnUrl?: string },
): string {
  const body = `
<h1>Sub-account confirmation</h1>
<table class="grid" cellpadding="4" cellspacing="0">
  <tr><th>Member ID</th><td>${escapeHtml(memberId)}</td></tr>
  <tr><th>Product</th><td>${escapeHtml(product)}</td></tr>
  <tr><th>Status</th><td>Pending fulfillment</td></tr>
</table>
<p>The sub-account request has been submitted. No additional funds have been moved.</p>
<p><a href="/members/${escapeHtml(memberId)}">Back to member</a></p>`;
  return contentDocument("Sub-account confirmation", body, {
    interstitial: opts?.interstitial,
    returnUrl: opts?.returnUrl ?? `/members/${memberId}/subaccount/confirm`,
  });
}

export function renderPageNotFound(): string {
  const body = `
<h1>Page not found</h1>
<p>The requested screen does not exist.</p>`;
  return contentDocument("Page not found", body);
}

export function renderInjectStatus(state: {
  ok: boolean;
  mode: InjectMode | null;
  once: boolean | null;
  error?: string;
}): string {
  const modeLinks = INJECT_MODES.map((mode) => {
    const href = `/__test/inject?mode=${encodeURIComponent(mode)}&amp;once=true`;
    return `<tr><td><a href="${href}">${escapeHtml(mode)}</a></td><td><code>?mode=${escapeHtml(mode)}&amp;once=true</code></td></tr>`;
  }).join("");
  const current =
    state.mode === null
      ? "none"
      : `${state.mode} (once=${state.once === true ? "true" : "false"})`;
  const error =
    state.error !== undefined ? `<p class="alert" role="alert">${escapeHtml(state.error)}</p>` : "";
  const armed =
    state.ok && state.mode !== null
      ? `<p role="status">Inject armed: <strong>${escapeHtml(state.mode)}</strong> (once=${state.once === true ? "true" : "false"}). Next matching request will apply it.</p>`
      : "";
  const body = `
<h1>Test inject</h1>
${error}
${armed}
<p>Current: ${escapeHtml(current)}</p>
<table class="grid">
  <tr><th>Mode</th><th>Arm (once)</th></tr>
  ${modeLinks}
  <tr><td><a href="/__test/inject?mode=clear">clear</a></td><td><code>?mode=clear</code></td></tr>
</table>
<p><a href="/">Return to workstation</a></p>`;
  return contentDocument("Test inject", body);
}
