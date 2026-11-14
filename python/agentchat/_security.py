"""Keep credentials out of diagnostic text (never applied to message content)."""

import re


def redact_error(value: object, token: str | None = None) -> str:
    text = str(value)
    if token:
        text = re.sub(r"(?<![A-Za-z0-9_-])" + re.escape(token) + r"(?![A-Za-z0-9_-])", "[REDACTED]", text)
    text = re.sub(r"ac_[A-Za-z0-9_-]+", "[REDACTED]", text)
    return re.sub(r"(?i)\bBearer\s+[^\s\"'<>]+", "Bearer [REDACTED]", text)
