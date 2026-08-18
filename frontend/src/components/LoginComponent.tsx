import React, { useState, useEffect } from 'react';
import { useAuth } from '../auth/authContext';
import appLogo from '../assets/app.png';

const LoginComponent: React.FC = () => {
  const { login, isLoading } = useAuth();
  const [configError, setConfigError] = useState<string>('');

  useEffect(() => {
    // Check if required environment variables are set
    const clientId = import.meta.env.VITE_AZURE_CLIENT_ID;
    const authority = import.meta.env.VITE_AZURE_AUTHORITY;
    if (!clientId || !authority) {
      setConfigError('Azure AD configuration is incomplete. Please check environment variables.');
    }
  }, []);

  const handleLogin = async () => {
    try {
      await login();
    } catch (error) {
      console.error('Login error:', error);
      setConfigError('Login failed. Please try again or contact support.');
    }
  };

  return (
    <main className="login-page">
      <section className="login-panel">
        <img className="login-mark" src={appLogo} alt="" />
        <span className="eyebrow">Secure clinical workspace</span>
        <h1>Rad Review</h1>
        <p>Collaborate on case selection with the physicians in your review group.</p>
        
        {configError && (
          <div className="login-error">
            <strong>Configuration error</strong>
            <span>{configError}</span>
          </div>
        )}

        <button onClick={handleLogin} disabled={isLoading || !!configError} className="button primary login-button">
              {isLoading ? (
                <>
                  <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Logging in...
                </>
              ) : (
                'Sign in with Microsoft'
              )}
        </button>
        <small>Access is limited to authorized clinical team members.</small>
      </section>
    </main>
  );
};

export default LoginComponent;
