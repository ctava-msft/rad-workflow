#!/usr/bin/env sh
set -eu

preferred_location="${AZURE_LOCATION:-eastus2}"
for command in az helm kubectl; do
	command -v "$command" >/dev/null 2>&1 || { printf '%s is required for azd up.\n' "$command" >&2; exit 1; }
done

printf "SegMed ICH review location: %s\n" "$preferred_location"
azd env set AZURE_LOCATION "$preferred_location" >/dev/null
