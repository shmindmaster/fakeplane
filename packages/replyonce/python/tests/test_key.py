import datetime as dt

import pytest

from replyonce import MISSING, canonical_json, effect_key, hash_payload, provider_idempotency_key

# Produced by the TypeScript package; Python must match byte for byte so both can share a store.
VECTORS = [
    ("reply", {"inReplyTo": "m1"}, '{"inReplyTo":"m1"}', "reply:b04f28335dc09bfd27ea14b2c7d5f4c3"),
    (
        "refund",
        {"order": "A-1001", "cents": 2500, "meta": {"b": [1, 2.5, True, None], "a": "é✓"}},
        '{"cents":2500,"meta":{"a":"é✓","b":[1,2.5,true,null]},"order":"A-1001"}',
        "refund:bffeea21f62d1cb45428c9574c926847",
    ),
    ("x", [3, "three", {"z": 1, "y": {"k": "v"}}], '[3,"three",{"y":{"k":"v"},"z":1}]', "x:02dd8cf162968cbb8ebec1c4dfad5430"),
    (
        "x",
        {"at": dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc), "n": 1.0, "big": 12345678901},
        '{"at":"2026-01-01T00:00:00.000Z","big":12345678901,"n":1}',
        "x:578a211449377e723fbdd7fbf2dbb389",
    ),
    ("x", None, "null", "x:74234e98afe7498fb5daf1f36ac2d78a"),
    # ECMAScript Number::toString thresholds and exponent formatting.
    ("x", {"n": 1e-7}, '{"n":1e-7}', "x:747d6d23b64d1b2d579adb832b44de31"),
    ("x", {"n": 1.5e-7}, '{"n":1.5e-7}', "x:ca0289a96d48abcb7088cf5581aadc70"),
    ("x", {"n": 1e-6}, '{"n":0.000001}', "x:28343867a0be00aee19f81aa90cfd6c6"),
    ("x", {"n": 1e-5}, '{"n":0.00001}', "x:694af9772b95df9403774a048bc7b0d7"),
    ("x", {"n": 1e20}, '{"n":100000000000000000000}', "x:58d2d5b8dd4228ab5775ce84f996718f"),
    ("x", {"n": 1e21}, '{"n":1e+21}', "x:f1ee2b60ee95a3170fdc07a577e5f351"),
    ("x", {"n": -1e21}, '{"n":-1e+21}', "x:fd33685f4e2a11dbebb3fd9717ea6449"),
    ("x", {"n": 0.0001}, '{"n":0.0001}', "x:eb596b9a807e0fbf971473088cea777f"),
    ("x", {"n": 1.2345678901234567e-8}, '{"n":1.2345678901234567e-8}', "x:74e069581ed661b8a161c255ae0fac95"),
    ("x", {"n": 1e-300}, '{"n":1e-300}', "x:8261d4fe2fd3eeb3dbea954ff257a6bc"),
    ("x", {"n": 2.0**60}, '{"n":1152921504606847000}', "x:730c537ef7e20d832661f6619b9b9be4"),
    ("x", {"n": 1000000000000000100.0}, '{"n":1000000000000000100}', "x:135ffdd59049a5e11240ffb79e442f05"),
    ("x", {"n": 10**21}, '{"n":1e+21}', "x:f1ee2b60ee95a3170fdc07a577e5f351"),
]


@pytest.mark.parametrize("intent,payload,canonical,key", VECTORS)
def test_matches_typescript(intent, payload, canonical, key):
    assert canonical_json(payload) == canonical
    assert effect_key(intent, payload) == key


def test_no_payload_and_provider_key_match_typescript():
    assert effect_key("reply") == "reply"
    assert effect_key("reply", MISSING) == "reply"
    assert provider_idempotency_key("conv-1", "refund:abc") == "ro_1387614e87a828dd8b7faf70276f1dce87f7ee1d"


def test_boolean_values_remain_json_literals():
    assert canonical_json(True) == "true"
    assert canonical_json(False) == "false"


def test_key_order_does_not_matter():
    assert hash_payload({"a": 1, "b": 2}) == hash_payload({"b": 2, "a": 1})


def test_rejects_bad_input():
    a: dict = {}
    a["self"] = a
    with pytest.raises(TypeError, match="circular"):
        hash_payload(a)
    with pytest.raises(TypeError, match="intent"):
        effect_key("has space", {})
