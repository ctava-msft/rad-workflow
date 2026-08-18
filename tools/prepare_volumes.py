from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "backend" / "data" / "manifest.json"
VOLUME_DIR = ROOT / "backend" / "data" / "volumes"
STORAGE_RESOURCE = "https://storage.azure.com/"
STORAGE_API_VERSION = "2023-11-03"


@dataclass(frozen=True)
class Volume:
    blob: str
    destination: Path
    size: int


def load_manifest() -> dict[str, Any]:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def volumes_from_manifest(manifest: dict[str, Any]) -> list[Volume]:
    volumes: dict[str, Volume] = {}
    for candidate in manifest.get("cases", []):
        for phase in ("prior", "later"):
            metadata = candidate[phase]["volume"]
            blob = PurePosixPath(metadata["source_blob"])
            if not blob.parts or blob.parts[0] != "nifti":
                raise ValueError(f"Unexpected source blob path: {blob}")
            relative_path = Path(*blob.parts[1:])
            destination = (VOLUME_DIR / relative_path).resolve()
            destination.relative_to(VOLUME_DIR.resolve())
            volumes[str(blob)] = Volume(
                blob=str(blob),
                destination=destination,
                size=int(metadata["size_bytes"]),
            )
    return sorted(volumes.values(), key=lambda volume: volume.blob)


def access_token(tenant_id: str | None) -> str:
    azure_cli = shutil.which("az")
    if not azure_cli:
        raise RuntimeError("Azure CLI was not found on PATH")
    command = [
        azure_cli,
        "account",
        "get-access-token",
        "--resource",
        STORAGE_RESOURCE,
        "--query",
        "accessToken",
        "--output",
        "tsv",
    ]
    if tenant_id:
        command.extend(["--tenant", tenant_id])
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    token = result.stdout.strip()
    if not token:
        raise RuntimeError("Azure CLI returned an empty Storage access token")
    return token


def blob_url(account: str, container: str, blob: str) -> str:
    encoded_blob = urllib.parse.quote(blob, safe="/")
    encoded_container = urllib.parse.quote(container, safe="")
    return f"https://{account}.blob.core.windows.net/{encoded_container}/{encoded_blob}"


def request_for(
    account: str,
    container: str,
    volume: Volume,
    token: str,
    method: str = "GET",
) -> urllib.request.Request:
    return urllib.request.Request(
        blob_url(account, container, volume.blob),
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "x-ms-version": STORAGE_API_VERSION,
        },
    )


def is_complete(volume: Volume) -> bool:
    return volume.destination.is_file() and volume.destination.stat().st_size == volume.size


def download_volume(
    account: str,
    container: str,
    volume: Volume,
    token: str,
) -> str:
    if is_complete(volume):
        return "cached"
    volume.destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = volume.destination.with_suffix(volume.destination.suffix + ".part")
    temporary.unlink(missing_ok=True)
    try:
        with urllib.request.urlopen(
            request_for(account, container, volume, token), timeout=180
        ) as response, temporary.open("wb") as stream:
            while chunk := response.read(1024 * 1024):
                stream.write(chunk)
        actual_size = temporary.stat().st_size
        if actual_size != volume.size:
            raise RuntimeError(
                f"Downloaded {actual_size} bytes for {volume.blob}; expected {volume.size}"
            )
        os.replace(temporary, volume.destination)
        return "downloaded"
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def gibibytes(value: int) -> str:
    return f"{value / (1024 ** 3):.2f} GiB"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download the SegMed NIfTI volumes referenced by the app manifest."
    )
    parser.add_argument(
        "--tenant-id",
        default=os.getenv("IMAGING_SOURCE_TENANT_ID"),
        help="Tenant used by Azure CLI for source Storage access.",
    )
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--check-access", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    manifest = load_manifest()
    volumes = volumes_from_manifest(manifest)
    total_size = sum(volume.size for volume in volumes)
    missing = [volume for volume in volumes if not is_complete(volume)]
    print(
        f"Manifest references {len(volumes)} volumes ({gibibytes(total_size)}); "
        f"{len(missing)} need download."
    )
    if args.plan:
        return

    source = manifest["source"]
    account = source["storage_account"]
    container = source["container"]
    token = access_token(args.tenant_id)

    if args.check_access:
        with urllib.request.urlopen(
            request_for(account, container, volumes[0], token, method="HEAD"),
            timeout=30,
        ) as response:
            remote_size = int(response.headers.get("Content-Length") or 0)
        if remote_size != volumes[0].size:
            raise RuntimeError(
                f"Source volume size is {remote_size}; expected {volumes[0].size}"
            )
        print("Source Storage access is available.")
        return

    if not missing:
        print("All volumes are ready.")
        return

    completed = 0
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        futures = {
            executor.submit(download_volume, account, container, volume, token): volume
            for volume in missing
        }
        for future in as_completed(futures):
            future.result()
            completed += 1
            print(f"Prepared {completed}/{len(missing)} volumes.")
    print(f"All {len(volumes)} volumes are ready in {VOLUME_DIR}.")


if __name__ == "__main__":
    main()