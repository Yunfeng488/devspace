"""Deployment-gate prewarm and integrity check for the DevSpace usage tokenizer."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

import tiktoken


ENCODING = "o200k_base"
ENCODING_URL = "https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken"
EXPECTED_PACKAGE_VERSION = "0.14.0"
EXPECTED_CACHE_SHA256 = "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache-dir", required=True)
    arguments = parser.parse_args()
    if sys.version_info[:2] != (3, 11):
        raise SystemExit("Python 3.11 is required")
    if getattr(tiktoken, "__version__", None) != EXPECTED_PACKAGE_VERSION:
        raise SystemExit("unexpected tiktoken version")

    cache_directory = os.path.abspath(arguments.cache_dir)
    os.makedirs(cache_directory, mode=0o700, exist_ok=True)
    os.environ["TIKTOKEN_CACHE_DIR"] = cache_directory
    encoding = tiktoken.get_encoding(ENCODING)
    if encoding.name != ENCODING:
        raise SystemExit("unexpected encoding")

    cache_key = hashlib.sha1(ENCODING_URL.encode("utf-8")).hexdigest()
    cache_path = os.path.join(cache_directory, cache_key)
    try:
        with open(cache_path, "rb") as cache_file:
            actual_hash = hashlib.sha256(cache_file.read()).hexdigest()
    except OSError as error:
        raise SystemExit("encoding cache was not created") from error
    if actual_hash != EXPECTED_CACHE_SHA256:
        raise SystemExit("encoding cache integrity check failed")

    print(json.dumps({
        "status": "VERIFIED",
        "package": "tiktoken",
        "version": EXPECTED_PACKAGE_VERSION,
        "encoding": ENCODING,
        "cache_sha256": actual_hash,
    }, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
