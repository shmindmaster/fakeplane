from __future__ import annotations

import json
import threading
from typing import Any, Callable, Optional


class MemoryStore:
    """Single-process store for tests, demos and single-instance services. Lost on restart.

    Atomic because ``transact`` reads, decides and writes without yielding to the event loop,
    under a lock in case several threads share it.
    """

    def __init__(self) -> None:
        self._data: dict[str, str] = {}
        self._lock = threading.Lock()

    async def transact(self, scope: str, fn: Callable[[Optional[dict]], tuple[Optional[dict], Any]]) -> Any:
        with self._lock:
            raw = self._data.get(scope)
            nxt, result = fn(None if raw is None else json.loads(raw))
            if nxt is not None:
                self._data[scope] = json.dumps(nxt)
            return result

    async def read(self, scope: str) -> Optional[dict]:
        raw = self._data.get(scope)
        return None if raw is None else json.loads(raw)

    def __len__(self) -> int:
        return len(self._data)
