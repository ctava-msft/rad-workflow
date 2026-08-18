#!/usr/bin/env pwsh

param()

$ErrorActionPreference = 'Stop'

function Get-AzdValues {
  $result = @{}
  foreach ($line in (azd env get-values)) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $value = $matches[2].Trim()
      if ($value.StartsWith('"') -and $value.EndsWith('"')) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      $result[$matches[1]] = $value
    }
  }
  return $result
}

function Require-Value([hashtable]$values, [string]$name) {
  if (-not $values.ContainsKey($name) -or [string]::IsNullOrWhiteSpace($values[$name])) {
    throw "Missing azd value: $name"
  }
  return $values[$name]
}

function Invoke-Checked([string]$command, [string[]]$arguments) {
  & $command @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$command failed with exit code $LASTEXITCODE"
  }
}

$hookDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $hookDirectory '..\..')
$previousLocation = Get-Location

try {
  Set-Location $repoRoot
  $values = Get-AzdValues
  $acrName = Require-Value $values 'CONTAINER_REGISTRY_NAME'
  $acrServer = Require-Value $values 'CONTAINER_REGISTRY'
  $aksName = Require-Value $values 'AKS_CLUSTER_NAME'
  $resourceGroup = Require-Value $values 'AZURE_RESOURCE_GROUP_NAME'
  $tenantId = Require-Value $values 'AZURE_TENANT_ID'
  $clientId = Require-Value $values 'ENTRA_CLIENT_ID'
  $apimUrl = Require-Value $values 'APIM_GATEWAY_URL'
  $frontendUrl = Require-Value $values 'FRONTEND_URL'
  $frontendHost = Require-Value $values 'FRONTEND_HOST'
  $dnsLabel = Require-Value $values 'FRONTEND_DNS_LABEL'

  Write-Host 'Building backend image in Azure Container Registry...' -ForegroundColor Cyan
  Invoke-Checked 'az' @(
    'acr', 'build', '--registry', $acrName,
    '--image', 'backend:latest', '--file', 'backend/Dockerfile', 'backend'
  )

  Write-Host 'Building frontend image in Azure Container Registry...' -ForegroundColor Cyan
  Invoke-Checked 'az' @(
    'acr', 'build', '--registry', $acrName,
    '--image', 'frontend:latest', '--file', 'frontend/Dockerfile',
    '--build-arg', "VITE_AZURE_CLIENT_ID=$clientId",
    '--build-arg', "VITE_AZURE_AUTHORITY=https://login.microsoftonline.com/$tenantId",
    '--build-arg', "VITE_AZURE_REDIRECT_URI=$frontendUrl",
    '--build-arg', "VITE_API_SCOPE=api://$clientId/access_as_user",
    '--build-arg', "VITE_API_URL=$apimUrl",
    'frontend'
  )

  Invoke-Checked 'az' @(
    'aks', 'get-credentials', '--resource-group', $resourceGroup,
    '--name', $aksName, '--admin', '--overwrite-existing'
  )

  Invoke-Checked 'helm' @('repo', 'add', 'ingress-nginx', 'https://kubernetes.github.io/ingress-nginx', '--force-update')
  Invoke-Checked 'helm' @('repo', 'add', 'jetstack', 'https://charts.jetstack.io', '--force-update')
  Invoke-Checked 'helm' @('repo', 'update')
  Invoke-Checked 'helm' @(
    'upgrade', '--install', 'ingress-nginx', 'ingress-nginx/ingress-nginx',
    '--namespace', 'ingress-nginx', '--create-namespace',
    '--set', 'controller.replicaCount=1',
    '--set-string', "controller.service.annotations.service\.beta\.kubernetes\.io/azure-dns-label-name=$dnsLabel",
    '--set-string', 'controller.service.annotations.service\.beta\.kubernetes\.io/azure-load-balancer-health-probe-request-path=/healthz',
    '--wait', '--timeout', '10m'
  )
  Invoke-Checked 'helm' @(
    'upgrade', '--install', 'cert-manager', 'jetstack/cert-manager',
    '--namespace', 'cert-manager', '--create-namespace',
    '--set', 'crds.enabled=true', '--wait', '--timeout', '10m'
  )

  $manifest = Get-Content 'k8s/app.yaml' -Raw
  $replacements = @{
    '__APPLICATIONINSIGHTS_CONNECTION_STRING__' = Require-Value $values 'APPLICATIONINSIGHTS_CONNECTION_STRING'
    '__AZURE_TENANT_ID__' = $tenantId
    '__BACKEND_IDENTITY_CLIENT_ID__' = Require-Value $values 'BACKEND_IDENTITY_CLIENT_ID'
    '__CONTAINER_REGISTRY__' = $acrServer
    '__COSMOS_CONTAINER_NAME__' = Require-Value $values 'COSMOS_CONTAINER_NAME'
    '__COSMOS_DATABASE_NAME__' = Require-Value $values 'COSMOS_DATABASE_NAME'
    '__COSMOS_ENDPOINT__' = Require-Value $values 'COSMOS_ENDPOINT'
    '__ENTRA_CLIENT_ID__' = $clientId
    '__FRONTEND_HOST__' = $frontendHost
    '__FRONTEND_URL__' = $frontendUrl
  }
  foreach ($entry in $replacements.GetEnumerator()) {
    $manifest = $manifest.Replace($entry.Key, $entry.Value)
  }

  $temporaryManifest = Join-Path ([System.IO.Path]::GetTempPath()) "rad-workflow-$([guid]::NewGuid()).yaml"
  try {
    Set-Content -Path $temporaryManifest -Value $manifest -Encoding utf8
    Invoke-Checked 'kubectl' @('apply', '-f', $temporaryManifest)
  }
  finally {
    Remove-Item $temporaryManifest -ErrorAction SilentlyContinue
  }

  Invoke-Checked 'kubectl' @(
    'rollout', 'restart', 'deployment/backend', 'deployment/frontend',
    '--namespace', 'radiology'
  )
  Invoke-Checked 'kubectl' @('rollout', 'status', 'deployment/backend', '--namespace', 'radiology', '--timeout', '10m')
  Invoke-Checked 'kubectl' @('rollout', 'status', 'deployment/frontend', '--namespace', 'radiology', '--timeout', '10m')

  Write-Host "SegMed ICH review deployed: $frontendUrl" -ForegroundColor Green
}
finally {
  Set-Location $previousLocation
}