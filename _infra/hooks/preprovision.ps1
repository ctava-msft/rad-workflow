#!/usr/bin/env pwsh
param()

$ErrorActionPreference = 'Stop'

$preferredLocation = if ($env:AZURE_LOCATION) { $env:AZURE_LOCATION } else { 'eastus2' }
foreach ($command in @('az', 'helm', 'kubectl')) {
	if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
		throw "$command is required for azd up."
	}
}

Write-Host "Radiology workflow location: $preferredLocation"
azd env set AZURE_LOCATION $preferredLocation | Out-Null
