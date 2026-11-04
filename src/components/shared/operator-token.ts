/**
 * The operator token (reset, hold review, automations) lives in sessionStorage for this tab only (plan section 6.8),
 * so a second action does not ask again. One key, one set of helpers, used by every form that needs the token.
 */
const TOKEN_KEY = "invoice-ap:reset-token";

export function readSavedToken(): string {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return ""; // storage blocked (private window, site data off): the form simply starts empty
  }
}

export function saveToken(token: string): void {
  try {
    window.sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // storage blocked: nothing to remember, nothing lost
  }
}

export function forgetToken(): void {
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage blocked: nothing was saved
  }
}
