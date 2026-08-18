import React from 'react'
import ReactDOM from 'react-dom/client'
import { PublicClientApplication } from '@azure/msal-browser'
import { MsalProvider } from '@azure/msal-react'
import App from './App.tsx'
import { AuthProvider } from './auth/AuthProvider.tsx'
import { msalConfig } from './auth/authConfig.ts'
import './app.css'

// Create MSAL instance
const msalInstance = new PublicClientApplication(msalConfig);

window.msalInstance = msalInstance;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MsalProvider instance={msalInstance}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MsalProvider>
  </React.StrictMode>,
)
