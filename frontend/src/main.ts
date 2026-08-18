import "./viewer.css";
import {
  initializeAuthentication,
  signIn,
  signOut,
} from "./auth";


function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) {
    throw new Error(`Missing required element: ${id}`);
  }
  return value as T;
}

const authGate = element<HTMLElement>("auth-gate");
const appShell = element<HTMLElement>("app-shell");
const authStatus = element<HTMLParagraphElement>("auth-status");
const signInButton = element<HTMLButtonElement>("sign-in");

signInButton.addEventListener("click", () => {
  signInButton.disabled = true;
  authStatus.textContent = "Redirecting to sign in...";
  void signIn().catch((error: unknown) => {
    console.error(error);
    authStatus.textContent = "Sign-in could not be started.";
    signInButton.disabled = false;
  });
});

element<HTMLButtonElement>("sign-out").addEventListener("click", () => {
  void signOut();
});

async function start(): Promise<void> {
  authStatus.textContent = "Checking your session...";
  const account = await initializeAuthentication();
  if (!account) {
    authStatus.textContent = "";
    authGate.hidden = false;
    return;
  }

  element<HTMLElement>("reviewer-name").textContent = account.name || account.username;
  authGate.hidden = true;
  appShell.hidden = false;
  await import("./viewer.js");
}

start().catch((error: unknown) => {
  console.error(error);
  authGate.hidden = false;
  authStatus.textContent = error instanceof Error
    ? `Unable to start: ${error.message}`
    : "Unable to start the application.";
});