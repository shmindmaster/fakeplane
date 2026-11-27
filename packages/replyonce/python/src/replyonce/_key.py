"""Keys and canonical hashing, byte-compatible with the TypeScript package."""

from __future__ import annotations

import dataclasses
import datetime as _dt
import hashlib
import json
import math
import re
from typing import Any

MISSING: Any = object()
"""Sentinel for "no payload" (distinct from a ``None`` payload, which hashes as JSON null)."""


class _RawNumber:
    """A number whose ECMAScript text form must be emitted without JSON quoting."""

    __slots__ = ("text",)

    def __init__(self, text: str) -> None:
        self.text = text


def _sort_key(k: str) -> bytes:
    # JavaScript sorts object keys by UTF-16 code units.
    return k.encode("utf-16-be")


def _iso(value: _dt.datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=_dt.timezone.utc)
    value = value.astimezone(_dt.timezone.utc)
    return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"


def _js_number(value: float) -> str:
    """Render a float the way ECMAScript Number::toString does.

    Python's repr uses different thresholds and pads exponents (``1e-07``,
    ``1e-06``), while JSON.stringify emits ``1e-7``, ``0.000001`` and switches
    to exponent notation only at 1e21. Keys must be byte-identical across the
    Python and TypeScript packages or the two runtimes cannot share a ledger.
    """
    if value == 0:
        return "0"  # includes -0.0, which JSON.stringify renders as 0
    negative = value < 0
    text = repr(abs(value))  # shortest round-trip digits
    if "e" in text:
        mantissa, exponent_text = text.split("e")
        exponent = int(exponent_text)
    else:
        mantissa, exponent = text, 0
    integer_part, _, fraction_part = mantissa.partition(".")
    digits = integer_part + fraction_part
    point = len(integer_part) + exponent
    leading = len(digits) - len(digits.lstrip("0"))
    digits = digits.lstrip("0")
    point -= leading
    digits = digits.rstrip("0") or "0"
    k = len(digits)
    n = point
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        exp = n - 1
        sign = "+" if exp >= 0 else "-"
        body = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + sign + str(abs(exp))
    return "-" + body if negative else body


def _normalize(value: Any, seen: set[int]) -> Any:
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        # JSON.parse in JS produces a double for every number token; Python
        # keeps an int. Above 2**53 the two runtimes must agree on the JS
        # shortest round-trip form or one payload gets two ledger keys.
        if abs(value) <= 2**53:
            return value
        return _RawNumber(_js_number(float(value)))
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        # Even integral doubles must use the JS shortest round-trip form:
        # int(2**60) is 1152921504606846976 in Python but JSON.stringify
        # emits 1152921504606847000. _js_number handles both forms.
        return _RawNumber(_js_number(value))
    if isinstance(value, _dt.datetime):
        return _iso(value)
    if isinstance(value, _dt.date):
        return _iso(_dt.datetime(value.year, value.month, value.day, tzinfo=_dt.timezone.utc))
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        value = dataclasses.asdict(value)
    elif hasattr(value, "model_dump") and callable(value.model_dump):
        value = value.model_dump()
    if id(value) in seen:
        raise TypeError("replyonce: cannot hash a circular payload")
    if isinstance(value, (list, tuple)):
        seen.add(id(value))
        out = [_normalize(v, seen) for v in value]
        seen.discard(id(value))
        return out
    if isinstance(value, dict):
        seen.add(id(value))
        items = sorted(((str(k), v) for k, v in value.items()), key=lambda kv: _sort_key(kv[0]))
        obj = {k: _normalize(v, seen) for k, v in items}
        seen.discard(id(value))
        return obj
    raise TypeError(f"replyonce: cannot hash a payload of type {type(value).__name__}")


def _encode(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, int):
        return int.__repr__(value)  # IntEnum str() is "Class.MEMBER" on Python 3.10
    if isinstance(value, _RawNumber):
        return value.text
    if isinstance(value, list):
        return "[" + ",".join(_encode(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            json.dumps(k, ensure_ascii=False) + ":" + _encode(v) for k, v in value.items()
        ) + "}"
    raise TypeError(f"replyonce: cannot hash a payload of type {type(value).__name__}")


def canonical_json(value: Any) -> str:
    """Deterministic JSON: keys sorted, no whitespace. Matches the TypeScript ``canonicalJson``."""
    return _encode(_normalize(value, set()))


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def hash_payload(payload: Any) -> str:
    return sha256_hex(canonical_json(payload))[:32]


_SAFE_INTENT = re.compile(r"^[A-Za-z0-9_.:-]{1,100}$")


def effect_key(intent: str, payload: Any = MISSING) -> str:
    """Ledger key for an intent plus the business identity of the payload."""
    if not isinstance(intent, str) or not _SAFE_INTENT.match(intent):
        raise TypeError(f"replyonce: intent must match {_SAFE_INTENT.pattern} (got {intent!r})")
    return intent if payload is MISSING else f"{intent}:{hash_payload(payload)}"


def provider_idempotency_key(scope: str, key: str) -> str:
    """Stable idempotency key to hand to a provider (Stripe-style ``Idempotency-Key``)."""
    return "ro_" + sha256_hex(f"{scope}\u0000{key}")[:40]
