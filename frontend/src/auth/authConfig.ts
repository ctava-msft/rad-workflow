import { Configuration, PopupRequest } from "@azure/msal-browser";

const apiScope = import.meta.env.VITE_API_SCOPE || `api://${import.meta.env.VITE_AZURE_CLIENT_ID}/access_as_user`;
const domainHint = import.meta.env.VITE_AZURE_DOMAIN_HINT;

// Validate required environment variables
const validateRequiredEnvVars = () => {
  const required = {
    clientId: import.meta.env.VITE_AZURE_CLIENT_ID,
    authority: import.meta.env.VITE_AZURE_AUTHORITY
  };

  const missing = Object.entries(required)
    .filter(([, value]) => !value || value.trim() === '')
    .map(([key]) => `VITE_AZURE_${key.toUpperCase()}`);

  if (missing.length > 0) {
    const error = `Missing required Azure AD configuration: ${missing.join(', ')}. Please check your .env file.`;
    console.error(error);
    throw new Error(error);
  }

  console.info('[MSAL Config] Authority:', required.authority);
  console.info('[MSAL Config] Current Origin:', window.location.origin);

  return required;
};

// Get validated environment variables
const envVars = validateRequiredEnvVars();

// Get the correct redirect URI based on environment
const getRedirectUri = (): string => {
  // Prefer the current origin so one image works behind local and AKS hosts.
  if (typeof window !== "undefined" && window.location && window.location.origin) {
    return window.location.origin;
  }

  const envRedirectUri = import.meta.env.VITE_AZURE_REDIRECT_URI;
  if (envRedirectUri) {
    return envRedirectUri;
  }

  return "http://localhost:5173";
};

// MSAL configuration following Azure best practices
export const msalConfig: Configuration = {
  auth: {
    clientId: envVars.clientId,
    authority: envVars.authority,
    redirectUri: getRedirectUri(),
    postLogoutRedirectUri: getRedirectUri(),
    navigateToLoginRequestUrl: false, // Recommended for SPAs
    clientCapabilities: ["CP1"] // Enable Conditional Access evaluation
  },
  cache: {
    cacheLocation: "localStorage", // Changed to localStorage for better persistence in healthcare apps
    storeAuthStateInCookie: true, // Enable for IE11/Edge compatibility and security
    secureCookies: window.location.protocol === "https:" // Ensure cookies are secure in production
  },
  system: {
    allowNativeBroker: false, // Disable for web apps
    windowHashTimeout: 60000, // Increase timeout for healthcare networks
    iframeHashTimeout: 6000,
    loadFrameTimeout: 0,
    loggerOptions: {
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) {
          return;
        }
        // Only log errors and warnings in production
        const logLevel = import.meta.env.PROD ? 1 : 3;
        if (level <= logLevel) {
          switch (level) {
            case 0: // LogLevel.Error
              console.error(`[MSAL Error]: ${message}`);
              return;
            case 1: // LogLevel.Warning
              console.warn(`[MSAL Warning]: ${message}`);
              return;
            case 2: // LogLevel.Info
              console.info(`[MSAL Info]: ${message}`);
              return;
            case 3: // LogLevel.Verbose
              console.debug(`[MSAL Debug]: ${message}`);
              return;
          }
        }
      },
      piiLoggingEnabled: false // Disable PII logging for healthcare compliance
    }
  }
};

export const loginRequest: PopupRequest = {
  scopes: [apiScope],
  prompt: "select_account",
  extraQueryParameters: domainHint ? { domain_hint: domainHint } : undefined,
};

export const apiRequest = {
  scopes: [apiScope]
};
