"""Line-delimited JSON worker for local, non-persistent o200k_base token counts."""

from __future__ import annotations

import json
import hashlib
import os
import sys

import tiktoken


ENCODING_URL = "https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken"
DEFAULT_CACHE_SHA256 = "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d"
EXPECTED_PACKAGE_VERSION = "0.14.0"


def verify_prewarmed_cache(expected_hash: str) -> bool:
    cache_directory = os.environ.get("TIKTOKEN_CACHE_DIR")
    if not cache_directory:
        return False
    cache_key = hashlib.sha1(ENCODING_URL.encode("utf-8")).hexdigest()
    cache_path = os.path.join(cache_directory, cache_key)
    try:
        with open(cache_path, "rb") as cache_file:
            actual_hash = hashlib.sha256(cache_file.read()).hexdigest()
    except OSError:
        return False
    return actual_hash == expected_hash


def main() -> int:
    expected_hash = DEFAULT_CACHE_SHA256
    prefix = "--expected-cache-sha256="
    for argument in sys.argv[1:]:
        if argument.startswith(prefix):
            expected_hash = argument[len(prefix) :]
    if (
        getattr(tiktoken, "__version__", None) != EXPECTED_PACKAGE_VERSION
        or len(expected_hash) != 64
        or any(character not in "0123456789abcdefABCDEF" for character in expected_hash)
        or not verify_prewarmed_cache(expected_hash)
    ):
        sys.stderr.write("tiktoken_cache_unavailable_or_invalid\n")
        return 2
    encoding = tiktoken.get_encoding("o200k_base")
    sys.stdout.write('{"ready":true}\n')
    sys.stdout.flush()
    for line in sys.stdin:
        request: object = {}
        try:
            request = json.loads(line)
            request_id = request["id"]
            text = request["text"]
            if not isinstance(request_id, int) or not isinstance(text, str):
                raise ValueError("invalid request")
            # MCP tool results are arbitrary model-visible text and may contain
            # strings that tiktoken reserves as special tokens. Count those
            # strings as ordinary text instead of rejecting the whole payload.
            response = {
                "id": request_id,
                "tokens": len(encoding.encode(text, disallowed_special=())),
            }
        except Exception as error:  # fail closed without echoing payload text
            response = {
                "id": request.get("id") if isinstance(request, dict) else None,
                "error": type(error).__name__,
            }
        sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
