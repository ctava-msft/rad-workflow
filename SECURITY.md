<!-- BEGIN MICROSOFT SECURITY.MD V1.0.0 BLOCK -->

## Security

Microsoft takes the security of our software products and services seriously,
including all source code repositories in our GitHub organizations.

**Do not report security vulnerabilities through public GitHub issues.** Report
them to the Microsoft Security Response Center at
[https://msrc.microsoft.com/create-report](https://msrc.microsoft.com/create-report).

## Application Controls

- Microsoft Entra ID authenticates clinicians in the SPA and protects every
  `/api/*` operation at both APIM and the FastAPI backend.
- The frontend is public over TLS; the backend and frontend Kubernetes Services
  remain `ClusterIP` and are reached through the NGINX ingress controller.
- The backend uses Azure Workload Identity for passwordless Cosmos DB access.
- Cosmos DB key authentication is disabled. The backend identity receives only
  the built-in Cosmos DB Data Contributor role.
- `DEVELOPMENT_MODE=true` bypasses interactive authentication only for local
  Docker development and is explicitly disabled in AKS.
- Case records should use a non-identifying patient reference. Do not place
  diagnostic images or unnecessary protected health information in review notes.
- Container images are built in Azure Container Registry and pulled by AKS with
  managed identity.

<!-- END MICROSOFT SECURITY.MD BLOCK -->