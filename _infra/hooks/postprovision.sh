#!/usr/bin/env sh

set -eu

hook_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH= cd -- "$hook_dir/../.." && pwd)"
values_file="$(mktemp)"
rendered_manifest="$(mktemp)"
trap 'rm -f "$values_file" "$rendered_manifest"' EXIT

cd "$repo_root"
azd env get-values > "$values_file"

get_value() {
  name="$1"
  line="$(grep -E "^[[:space:]]*${name}[[:space:]]*=" "$values_file" | head -n 1 || true)"
  [ -n "$line" ] || { printf 'Missing azd value: %s\n' "$name" >&2; exit 1; }
  value="${line#*=}"
  value="$(printf '%s' "$value" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s/^"//; s/"$//')"
  [ -n "$value" ] || { printf 'Empty azd value: %s\n' "$name" >&2; exit 1; }
  printf '%s' "$value"
}

acr_name="$(get_value CONTAINER_REGISTRY_NAME)"
acr_server="$(get_value CONTAINER_REGISTRY)"
aks_name="$(get_value AKS_CLUSTER_NAME)"
resource_group="$(get_value AZURE_RESOURCE_GROUP_NAME)"
tenant_id="$(get_value AZURE_TENANT_ID)"
client_id="$(get_value ENTRA_CLIENT_ID)"
apim_url="$(get_value APIM_GATEWAY_URL)"
frontend_url="$(get_value FRONTEND_URL)"
frontend_host="$(get_value FRONTEND_HOST)"
dns_label="$(get_value FRONTEND_DNS_LABEL)"

az acr build --registry "$acr_name" --image backend:latest --file backend/Dockerfile backend
az acr build --registry "$acr_name" --image frontend:latest --file frontend/Dockerfile \
  --build-arg "VITE_AZURE_CLIENT_ID=$client_id" \
  --build-arg "VITE_AZURE_AUTHORITY=https://login.microsoftonline.com/$tenant_id" \
  --build-arg "VITE_AZURE_REDIRECT_URI=$frontend_url" \
  --build-arg "VITE_API_SCOPE=api://$client_id/access_as_user" \
  --build-arg "VITE_API_URL=$apim_url" frontend

az aks get-credentials --resource-group "$resource_group" --name "$aks_name" --admin --overwrite-existing

helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx --force-update
helm repo add jetstack https://charts.jetstack.io --force-update
helm repo update
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace \
  --set controller.replicaCount=1 \
  --set-string "controller.service.annotations.service\\.beta\\.kubernetes\\.io/azure-dns-label-name=$dns_label" \
  --set-string "controller.service.annotations.service\\.beta\\.kubernetes\\.io/azure-load-balancer-health-probe-request-path=/healthz" \
  --wait --timeout 10m
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  --set crds.enabled=true --wait --timeout 10m

cp k8s/app.yaml "$rendered_manifest"
replace_value() {
  placeholder="$1"
  replacement="$(printf '%s' "$2" | sed 's/[&|]/\\&/g')"
  next_manifest="${rendered_manifest}.next"
  sed "s|${placeholder}|${replacement}|g" "$rendered_manifest" > "$next_manifest"
  mv "$next_manifest" "$rendered_manifest"
}

replace_value __APPLICATIONINSIGHTS_CONNECTION_STRING__ "$(get_value APPLICATIONINSIGHTS_CONNECTION_STRING)"
replace_value __AZURE_TENANT_ID__ "$tenant_id"
replace_value __BACKEND_IDENTITY_CLIENT_ID__ "$(get_value BACKEND_IDENTITY_CLIENT_ID)"
replace_value __CONTAINER_REGISTRY__ "$acr_server"
replace_value __COSMOS_CONTAINER_NAME__ "$(get_value COSMOS_CONTAINER_NAME)"
replace_value __COSMOS_DATABASE_NAME__ "$(get_value COSMOS_DATABASE_NAME)"
replace_value __COSMOS_ENDPOINT__ "$(get_value COSMOS_ENDPOINT)"
replace_value __ENTRA_CLIENT_ID__ "$client_id"
replace_value __FRONTEND_HOST__ "$frontend_host"
replace_value __FRONTEND_URL__ "$frontend_url"

kubectl apply -f "$rendered_manifest"
kubectl rollout restart deployment/backend deployment/frontend --namespace radiology
kubectl rollout status deployment/backend --namespace radiology --timeout 10m
kubectl rollout status deployment/frontend --namespace radiology --timeout 10m

printf 'SegMed ICH review deployed: %s\n' "$frontend_url"