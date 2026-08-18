targetScope = 'resourceGroup'

param environmentName string
param location string
param entraClientId string
param publisherEmail string
param apimSku string
param aksNodeVmSize string
param cosmosDatabaseName string
param cosmosContainerName string
param tags object

var suffix = toLower(uniqueString(subscription().id, environmentName, location))
var acrName = 'cr${suffix}'
var aksName = 'aks-${suffix}'
var cosmosName = 'cosmos-${suffix}'
var apimName = 'apim-${suffix}'
var logAnalyticsName = 'log-${suffix}'
var appInsightsName = 'appi-${suffix}'
var backendIdentityName = 'id-rad-backend-${suffix}'
var frontendDnsLabel = 'rad-${suffix}'
var frontendHost = '${frontendDnsLabel}.${location}.cloudapp.azure.com'
var frontendUrl = 'https://${frontendHost}'
var apiBackendUrl = '${frontendUrl}/api'
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var cosmosDataContributorRoleId = '00000000-0000-0000-0000-000000000002'

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  tags: tags
  properties: {
    retentionInDays: 30
    sku: {
      name: 'PerGB2018'
    }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    DisableLocalAuth: false
  }
}

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
    networkRuleBypassOptions: 'AzureServices'
  }
}

resource aksCluster 'Microsoft.ContainerService/managedClusters@2024-02-01' = {
  name: aksName
  location: location
  tags: tags
  sku: {
    name: 'Base'
    tier: 'Free'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    dnsPrefix: aksName
    enableRBAC: true
    disableLocalAccounts: false
    aadProfile: {
      managed: true
      enableAzureRBAC: true
    }
    agentPoolProfiles: [
      {
        name: 'system'
        count: 1
        vmSize: aksNodeVmSize
        osDiskSizeGB: 64
        osType: 'Linux'
        mode: 'System'
        type: 'VirtualMachineScaleSets'
        enableAutoScaling: false
        maxPods: 30
      }
    ]
    networkProfile: {
      networkPlugin: 'azure'
      networkPluginMode: 'overlay'
      networkPolicy: 'azure'
      podCidr: '10.244.0.0/16'
      serviceCidr: '10.240.0.0/16'
      dnsServiceIP: '10.240.0.10'
      loadBalancerSku: 'standard'
      outboundType: 'loadBalancer'
    }
    addonProfiles: {
      omsagent: {
        enabled: true
        config: {
          logAnalyticsWorkspaceResourceID: logAnalytics.id
        }
      }
    }
    oidcIssuerProfile: {
      enabled: true
    }
    securityProfile: {
      workloadIdentity: {
        enabled: true
      }
    }
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: containerRegistry
  name: guid(containerRegistry.id, aksCluster.id, acrPullRoleId)
  properties: {
    principalId: aksCluster.properties.identityProfile.kubeletidentity.objectId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
  }
}

resource backendIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: backendIdentityName
  location: location
  tags: tags
}

resource backendFederatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: backendIdentity
  name: 'aks-radiology-backend'
  properties: {
    audiences: [
      'api://AzureADTokenExchange'
    ]
    issuer: aksCluster.properties.oidcIssuerProfile.issuerURL
    subject: 'system:serviceaccount:radiology:backend'
  }
}

resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: cosmosName
  location: location
  tags: tags
  kind: 'GlobalDocumentDB'
  properties: {
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    databaseAccountOfferType: 'Standard'
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    capabilities: [
      {
        name: 'EnableServerless'
      }
    ]
    disableLocalAuth: true
    enableAutomaticFailover: false
    enableMultipleWriteLocations: false
    publicNetworkAccess: 'Enabled'
  }
}

resource cosmosDatabase 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: cosmosAccount
  name: cosmosDatabaseName
  tags: tags
  properties: {
    options: {}
    resource: {
      id: cosmosDatabaseName
    }
  }
}

resource cosmosContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: cosmosDatabase
  name: cosmosContainerName
  tags: tags
  properties: {
    options: {}
    resource: {
      id: cosmosContainerName
      partitionKey: {
        paths: [
          '/case_id'
        ]
        kind: 'Hash'
        version: 2
      }
    }
  }
}

resource cosmosDataContributor 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, backendIdentity.id, cosmosDataContributorRoleId)
  properties: {
    principalId: backendIdentity.properties.principalId
    roleDefinitionId: '${cosmosAccount.id}/sqlRoleDefinitions/${cosmosDataContributorRoleId}'
    scope: cosmosAccount.id
  }
}

resource apiManagement 'Microsoft.ApiManagement/service@2023-09-01-preview' = {
  name: apimName
  location: location
  tags: tags
  sku: {
    name: apimSku
    capacity: 1
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    publisherEmail: publisherEmail
    publisherName: 'Radiology Workflow'
  }
}

resource radiologyApi 'Microsoft.ApiManagement/service/apis@2023-09-01-preview' = {
  parent: apiManagement
  name: 'radiology'
  properties: {
    apiType: 'http'
    displayName: 'Radiology Collaboration API'
    path: 'api'
    protocols: [
      'https'
    ]
    serviceUrl: apiBackendUrl
    subscriptionRequired: false
  }
}

var apiMethods = [
  'GET'
  'POST'
  'PATCH'
  'OPTIONS'
]

resource apiOperations 'Microsoft.ApiManagement/service/apis/operations@2023-09-01-preview' = [for method in apiMethods: {
  parent: radiologyApi
  name: toLower(method)
  properties: {
    displayName: '${method} proxy'
    method: method
    templateParameters: [
      {
        name: 'path'
        required: true
        type: 'string'
      }
    ]
    urlTemplate: '/{*path}'
  }
}]

var apiPolicyTemplate = '''
<policies>
  <inbound>
    <base />
    <cors allow-credentials="false">
      <allowed-origins>
        <origin>__FRONTEND_URL__</origin>
        <origin>http://localhost:5173</origin>
      </allowed-origins>
      <allowed-methods preflight-result-max-age="300">
        <method>GET</method>
        <method>POST</method>
        <method>PATCH</method>
        <method>OPTIONS</method>
      </allowed-methods>
      <allowed-headers>
        <header>authorization</header>
        <header>content-type</header>
      </allowed-headers>
    </cors>
    <validate-jwt header-name="Authorization" failed-validation-httpcode="401" failed-validation-error-message="Invalid or missing access token" require-scheme="Bearer">
      <openid-config url="__LOGIN_ENDPOINT____TENANT_ID__/v2.0/.well-known/openid-configuration" />
      <audiences>
        <audience>__CLIENT_ID__</audience>
        <audience>api://__CLIENT_ID__</audience>
      </audiences>
    </validate-jwt>
  </inbound>
  <backend><base /></backend>
  <outbound><base /></outbound>
  <on-error><base /></on-error>
</policies>
'''
var policyWithOrigin = replace(apiPolicyTemplate, '__FRONTEND_URL__', frontendUrl)
var policyWithLogin = replace(policyWithOrigin, '__LOGIN_ENDPOINT__', environment().authentication.loginEndpoint)
var policyWithTenant = replace(policyWithLogin, '__TENANT_ID__', tenant().tenantId)
var apiPolicy = replace(policyWithTenant, '__CLIENT_ID__', entraClientId)

resource radiologyApiPolicy 'Microsoft.ApiManagement/service/apis/policies@2023-09-01-preview' = {
  parent: radiologyApi
  name: 'policy'
  properties: {
    format: 'xml'
    value: apiPolicy
  }
}

output APPLICATIONINSIGHTS_CONNECTION_STRING string = appInsights.properties.ConnectionString
output AKS_CLUSTER_NAME string = aksCluster.name
output APIM_GATEWAY_URL string = apiManagement.properties.gatewayUrl
output BACKEND_IDENTITY_CLIENT_ID string = backendIdentity.properties.clientId
output CONTAINER_REGISTRY string = containerRegistry.properties.loginServer
output CONTAINER_REGISTRY_NAME string = containerRegistry.name
output COSMOS_CONTAINER_NAME string = cosmosContainer.name
output COSMOS_DATABASE_NAME string = cosmosDatabase.name
output COSMOS_ENDPOINT string = cosmosAccount.properties.documentEndpoint
output FRONTEND_DNS_LABEL string = frontendDnsLabel
output FRONTEND_HOST string = frontendHost
output FRONTEND_URL string = frontendUrl