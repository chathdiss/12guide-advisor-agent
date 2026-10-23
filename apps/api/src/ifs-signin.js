// Is the page the sign-in page of IFS? It has a different address (the IFS login lives on the same host under /auth/realms/...), or a password field.
// Used by every script that opens IFS with a saved session: a session that has expired shows the sign-in page, sometimes only a moment after the page
// opened, so this is also asked when something on the next page is not found.
export const LOGIN_PATH = /(login|log-in|signin|sign-in|logon|openid|oauth|authorize|\/auth\b)/i;

export async function asksForSignIn(page, host) {
  try {
    const here = new URL(page.url());
    if (here.host !== host || LOGIN_PATH.test(here.pathname)) return true;
    return (await page.locator('input[type="password"]').count()) > 0;
  } catch {
    return false;
  }
}

export const SIGN_IN_AGAIN = "IFS asked for a sign-in, so the saved session has expired or is missing. Save a new one with npm run ifs:login (you sign in yourself); nothing was bypassed.";
