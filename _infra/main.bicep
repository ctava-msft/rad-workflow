targetScope = 'subscription'

@minLength(1)
@maxLength(40)
param environmentName string

param location string

@minLength(36)
@description('Client ID of the Entra SPA/API app registration used by clinicians.')
param entraClientId string

@description('Publisher email required by API Management.')
param publisherEmail string = 'noreply@example.com'

@allowed([
  'Basicv2'
  'Standardv2'
  'Developer'
])
param apimSku string = 'Basicv2'

@description('CPU-only VM size for the single AKS system node pool.')
param aksNodeVmSize string = 'Standard_D2s_v5'

param cosmosDatabaseName string = 'radiology'
param cosmosContainerName string = 'cases'

var resourceGroupName = 'rg-${environmentName}'
var tags = {
  'azd-env-name': environmentName
  application: 'rad-workflow'
}

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module application './app.bicep' = {
  name: 'radiology-stack'
  scope: resourceGroup
  params: {
    aksNodeVmSize: aksNodeVmSize
    apimSku: apimSku
    cosmosContainerName: cosmosContainerName
    cosmosDatabaseName: cosmosDatabaseName
    entraClientId: entraClientId
    environmentName: environmentName
    location: location
    publisherEmail: publisherEmail
    tags: tags
  }
}

output APPLICATIONINSIGHTS_CONNECTION_STRING string = application.outputs.APPLICATIONINSIGHTS_CONNECTION_STRING
output AKS_CLUSTER_NAME string = application.outputs.AKS_CLUSTER_NAME
output APIM_GATEWAY_URL string = application.outputs.APIM_GATEWAY_URL
output AZURE_LOCATION string = location
output AZURE_RESOURCE_GROUP_NAME string = resourceGroup.name
output AZURE_TENANT_ID string = tenant().tenantId
output BACKEND_IDENTITY_CLIENT_ID string = application.outputs.BACKEND_IDENTITY_CLIENT_ID
output CONTAINER_REGISTRY string = application.outputs.CONTAINER_REGISTRY
output CONTAINER_REGISTRY_NAME string = application.outputs.CONTAINER_REGISTRY_NAME
output COSMOS_CONTAINER_NAME string = application.outputs.COSMOS_CONTAINER_NAME
output COSMOS_DATABASE_NAME string = application.outputs.COSMOS_DATABASE_NAME
output COSMOS_ENDPOINT string = application.outputs.COSMOS_ENDPOINT
output ENTRA_CLIENT_ID string = entraClientId
output FRONTEND_DNS_LABEL string = application.outputs.FRONTEND_DNS_LABEL
output FRONTEND_HOST string = application.outputs.FRONTEND_HOST
output FRONTEND_URL string = application.outputs.FRONTEND_URL