/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AZURE_CLIENT_ID: string
  readonly VITE_AZURE_AUTHORITY: string
  readonly VITE_AZURE_REDIRECT_URI: string
  readonly VITE_API_URL: string
  readonly VITE_API_SCOPE: string
  readonly VITE_AZURE_DOMAIN_HINT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
