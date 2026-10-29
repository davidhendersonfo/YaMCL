"""Databricks access for YaMCL.

Uses the same connector and per-user OAuth as the YALnT server: the first query opens a
Databricks login in your browser, and the token is cached to a file after that.
This version only reads. Nothing here writes to any table.
"""
import json
import os
import re
import threading
import time

try:
    from databricks import sql as dbsql
    from databricks.sql.experimental.oauth_persistence import DevOnlyFilePersistence
except ImportError:  # the app still works without Databricks
    dbsql = None
    DevOnlyFilePersistence = None


# Delta rejects one of two simultaneous writes to the same table. A rejected write committed
# nothing, so it's the one kind of failure that is safe to retry.
CONFLICT_RE = re.compile(r"Concurrent\w*Exception|DELTA_CONCURRENT|ConcurrentModification|concurrent update", re.I)


def is_conflict(e):
    return bool(CONFLICT_RE.search(str(e)))


def to_list(v):
    """Array columns can come back as lists, numpy arrays or JSON text; normalise to a list of str."""
    if v is None:
        return []
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return [v] if v.strip() else []
    if hasattr(v, "tolist"):
        v = v.tolist()
    if not isinstance(v, (list, tuple)):
        return [str(v)]
    return [str(x) for x in v if x is not None and str(x).strip()]


class Databricks:
    def __init__(self, cfg, base_dir):
        self.cfg = cfg or {}
        self.base_dir = base_dir
        self._conn = None
        self._lock = threading.Lock()  # one statement at a time on the shared connection
        self.last_error = None

    # ---------------------------------------------------------------- setup

    def reconfigure(self, cfg):
        """Apply new settings. Drops the open connection only if where/how we connect changed."""
        cfg = cfg or {}
        conn_keys = ("hostname", "http_path", "token_file")
        changed = any((cfg.get(k) or "") != (self.cfg.get(k) or "") for k in conn_keys)
        with self._lock:
            self.cfg = cfg
            if changed:
                self._close()
                self.last_error = None

    @property
    def installed(self):
        return dbsql is not None

    @property
    def configured(self):
        return bool(self.cfg.get("hostname") and self.cfg.get("http_path"))

    @property
    def connected(self):
        return self._conn is not None

    def table(self, key, default):
        return (self.cfg.get("tables") or {}).get(key, default)

    def token_file(self):
        path = self.cfg.get("token_file") or os.path.join(self.base_dir, ".local", "databricks_oauth.json")
        return os.path.abspath(os.path.expandvars(os.path.expanduser(path)))

    def _connect(self):
        token_file = self.token_file()
        os.makedirs(os.path.dirname(token_file), exist_ok=True)
        return dbsql.connect(
            server_hostname=self.cfg["hostname"],
            http_path=self.cfg["http_path"],
            auth_type="databricks-oauth",
            experimental_oauth_persistence=DevOnlyFilePersistence(token_file),
        )

    def _close(self):
        try:
            if self._conn is not None:
                self._conn.close()
        except Exception:  # noqa: BLE001 - closing a dead connection can fail; we're discarding it anyway
            pass
        self._conn = None

    # ---------------------------------------------------------------- queries

    def query(self, statement, params=None, retry=True):
        """Run one statement and return rows as dicts. Reconnects once if the connection went stale,
        unless retry=False (used for writes: re-running a write that may have committed could apply it twice)."""
        if not self.installed:
            raise RuntimeError("databricks-sql-connector isn't installed. Run: pip install -r requirements.txt")
        if not self.configured:
            raise RuntimeError("Databricks isn't set up in config.json (databricks.hostname / http_path).")
        with self._lock:
            for attempt in ((1, 2) if retry else (2,)):
                try:
                    if self._conn is None:
                        self._conn = self._connect()
                    with self._conn.cursor() as cur:
                        cur.execute(statement, params or [])
                        cols = [d[0] for d in (cur.description or [])]
                        rows = cur.fetchall() if cols else []
                    self.last_error = None
                    return [dict(zip(cols, tuple(r))) for r in rows]
                except Exception as e:  # noqa: BLE001 - surfaced to the UI as a message
                    self._close()
                    self.last_error = str(e)
                    if attempt == 2:
                        raise
        return []

    def load_sql(self, name, **fmt):
        """queries/<name>.sql with {placeholders} filled. `fmt` only takes trusted values (table names, limits)."""
        path = os.path.join(self.base_dir, "queries", f"{name}.sql")
        with open(path, encoding="utf-8") as f:
            statement = f.read()
        for key, value in fmt.items():
            statement = statement.replace("{" + key + "}", str(value))
        return statement

    def query_file(self, name, params=None, **fmt):
        return self.query(self.load_sql(name, **fmt), params)

    def write_file(self, name, params=None, conflicts=3, **fmt):
        """A write: make sure the connection is alive first (that check may retry), then run once.
        Only a Delta write conflict (which means nothing was committed) is retried, up to `conflicts` times."""
        self.query("select 1 as ok")
        statement = self.load_sql(name, **fmt)
        for attempt in range(conflicts + 1):
            try:
                return self.query(statement, params, retry=False)
            except Exception as e:  # noqa: BLE001
                if attempt < conflicts and is_conflict(e):
                    time.sleep(0.4 * (attempt + 1))
                    continue
                raise
        return []

    def whoami(self):
        """The signed-in Databricks user (an email), cached per connection settings."""
        key = (self.cfg.get("hostname"), self.cfg.get("token_file"))
        if getattr(self, "_who", None) and self._who[0] == key:
            return self._who[1]
        rows = self.query("select current_user() as u")
        user = str(rows[0]["u"]) if rows else ""
        self._who = (key, user)
        return user
