/**
 * Deterministic seed data for CoreBank Lite.
 * Plain constants — no database, no timestamps, no generated IDs.
 */
export const APP_NAME = "CoreBank Lite";
export const APP_VERSION = "2.1.0";

export const AUTH_COOKIE = "cbl_session";
/** Fixed session token. Never random — observations must hash identically. */
export const AUTH_COOKIE_VALUE = "teller";

export const LOGIN = {
  username: "teller",
  password: "password",
} as const;

export const EXISTING_MEMBER_ID = "12345";
export const UNKNOWN_MEMBER_ID = "99999";
export const FORBIDDEN_MEMBER_ID = "77777";

export type Account = {
  type: string;
  number: string;
  balance: string;
};

export type Member = {
  memberId: string;
  name: string;
  accounts: readonly Account[];
};

/**
 * Member 12345 is the only record that can be looked up successfully.
 * Savings balance is fixed so later extract/verify steps can key off it.
 */
export const MEMBERS: Readonly<Record<string, Member>> = {
  [EXISTING_MEMBER_ID]: {
    memberId: EXISTING_MEMBER_ID,
    name: "Jane Rivera",
    accounts: [
      { type: "Savings", number: "****4412", balance: "$4,210.55" },
      { type: "Checking", number: "****8891", balance: "$1,002.00" },
      { type: "Certificate", number: "****2207", balance: "$8,000.00" },
    ],
  },
};

export const SUBACCOUNT_PRODUCTS = ["Money Market", "Certificate of Deposit"] as const;

/** Fixed ASP.NET-style viewstate. Must not change between requests. */
export const VIEWSTATE = "Y29yZWJhbmstbGl0ZS12aWV3c3RhdGU=";

export const SLOW_DELAY_DEFAULT_MS = 3000;
