import {
  AccountInfo,
  Configuration,
  InteractionRequiredAuthError,
  PublicClientApplication,
} from "@azure/msal-browser";


const clientId = import.meta.env.VITE_AZURE_CLIENT_ID?.trim();
const authority = import.meta.env.VITE_AZURE_AUTHORITY?.trim();
const apiScope = import.meta.env.VITE_API_SCOPE?.trim()
  || `api://${clientId}/access_as_user`;
const apiBaseUrl = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

if (!clientId || !authority) {
  throw new Error("VITE_AZURE_CLIENT_ID and VITE_AZURE_AUTHORITY are required.");
}

const configuration: Configuration = {
  auth: {
    clientId,
    authority,
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
    navigateToLoginRequestUrl: false,
    clientCapabilities: ["CP1"],
  },
  cache: {
    cacheLocation: "localStorage",
    storeAuthStateInCookie: true,
    secureCookies: window.location.protocol === "https:",
  },
  system: {
    allowNativeBroker: false,
  },
};

const instance = new PublicClientApplication(configuration);
const request = {
  scopes: [apiScope],
  extraQueryParameters: import.meta.env.VITE_AZURE_DOMAIN_HINT
    ? { domain_hint: import.meta.env.VITE_AZURE_DOMAIN_HINT }
    : undefined,
};

export async function initializeAuthentication(): Promise<AccountInfo | null> {
  await instance.initialize();
  const redirect = await instance.handleRedirectPromise();
  const account = redirect?.account ?? instance.getActiveAccount() ?? instance.getAllAccounts()[0] ?? null;
  if (account) {
    instance.setActiveAccount(account);
  }
  return account;
}

export async function signIn(): Promise<void> {
  await instance.loginRedirect({ ...request, prompt: "select_account" });
}

export async function signOut(): Promise<void> {
  await instance.logoutRedirect({ account: instance.getActiveAccount() ?? undefined });
}

async function getAccessToken(): Promise<string> {
  const account = instance.getActiveAccount();
  if (!account) {
    throw new Error("No authenticated account is available.");
  }
  try {
    return (await instance.acquireTokenSilent({ ...request, account })).accessToken;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      await instance.acquireTokenRedirect({ ...request, account });
    }
    throw error;
  }
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${await getAccessToken()}`);
  return fetch(`${apiBaseUrl}/api${path}`, { ...init, headers });
}