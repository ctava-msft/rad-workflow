import { ReactNode } from 'react';
import { 
  useMsal, 
  useAccount, 
  useIsAuthenticated
} from '@azure/msal-react';
import { InteractionStatus } from '@azure/msal-browser';
import { AuthContext, AuthContextType } from './authContext';
import { loginRequest } from './authConfig';

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const { instance, inProgress } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const account = useAccount();

  const currentAccount = account || instance.getActiveAccount() || instance.getAllAccounts()[0] || null;

  const login = async () => {
    try {
      await instance.loginPopup(loginRequest);
    } catch (error) {
      console.error('Login failed:', error);
    }
  };

  const logout = async () => {
    try {
      await instance.logoutPopup();
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  const value: AuthContextType = {
    isAuthenticated,
    user: currentAccount,
    login,
    logout,
    isLoading: inProgress === InteractionStatus.Login || inProgress === InteractionStatus.Logout
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}
