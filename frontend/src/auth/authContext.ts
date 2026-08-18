import { AccountInfo } from "@azure/msal-browser";
import { createContext, useContext } from "react";

export interface AuthContextType {
  isAuthenticated: boolean;
  user: AccountInfo | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  isLoading: boolean;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}