"""YaMCL (yet another MCL tool) - a local Flask app for stepping through New-To-MCL rows.

Run:  python app.py   then open http://127.0.0.1:5050
"""
import csv
import io
import json
import os
import re
import threading
import uuid
from datetime import datetime, timedelta

from flask import Flask, jsonify, render_template, request, send_file
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill

import editor
import publish
from db import Databricks, to_list

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
STATE_FILE = os.path.join(DATA_DIR, "session.json")
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")        # shared: in the team's git repo
LOCAL_CONFIG_FILE = os.path.join(BASE_DIR, "config.local.json")  # personal: this computer only, never pushed

app = Flask(__name__)
app.config["TEMPLATES_AUTO_RELOAD"] = True  # an updated page shows up without restarting
_lock = threading.Lock()


@app.context_processor
def asset_version():
    """Adds ?v=<last change> to the scripts and styles, so browsers fetch new ones after an update."""
    static = os.path.join(BASE_DIR, "static")
    try:
        stamp = max(os.path.getmtime(os.path.join(static, f)) for f in os.listdir(static))
    except (OSError, ValueError):
        stamp = 0
    return {"v": int(stamp)}

# canonical field -> accepted header spellings (compared lowercase, spaces/underscores removed)
FIELDS = {
    "phoneNumbers": ["phonenumbers", "phonenumber", "phones", "phone"],
    "createdBys": ["createdbys", "createdby"],
    "partyName": ["partyname"],
    "name_variations": ["namevariations", "variations"],
    "industry": ["industry", "industrytype"],
    "partyTypes": ["partytypes", "partytype"],
    "notes": ["notes", "note"],
}
DEFAULT_HEADERS = {
    "phoneNumbers": "phoneNumbers",
    "createdBys": "createdBys",
    "partyName": "partyName",
    "name_variations": "name_variations",
    "industry": "industry",
    "partyTypes": "partytypes",
    "notes": "Notes",
}
EXPORT_ORDER = ["phoneNumbers", "createdBys", "partyName", "name_variations",
                "industry", "partyTypes", "notes"]
STATUSES = {"pending", "approved", "denied", "flagged"}
SMART_QUOTES = str.maketrans({"\u201c": '"', "\u201d": '"', "\u2018": "'", "\u2019": "'"})


# ---------------------------------------------------------------- parsing

def norm_header(h):
    return re.sub(r"[\s_\-]", "", str(h or "")).lower()


def cell_str(v):
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v)


def parse_list(v):
    """'["CS","EN"]' / 'CS,EN' / '[“CS”,”EN”]' -> ['CS', 'EN']"""
    s = cell_str(v).translate(SMART_QUOTES).strip()
    if not s:
        return []
    if s.startswith("["):
        try:
            parsed = json.loads(s)
            if isinstance(parsed, list):
                return [cell_str(x).strip() for x in parsed if cell_str(x).strip()]
        except ValueError:
            pass
        s = s[1:-1] if s.endswith("]") else s[1:]
    items = (p.strip().strip("\"'").strip() for p in s.split(","))
    return [p for p in items if p]


def collapse(s):
    return re.sub(r"\s{2,}", " ", str(s or "")).strip()


def name_variants(name):
    """Every spelling of a name: itself and its "and" <-> "&" swaps, each as written, lowercase and
    UPPERCASE (the name itself left out). Same rule as the queue query and the page."""
    name = collapse(name)
    if not name:
        return []
    word = "AND" if name == name.upper() and name != name.lower() else "and"
    bases = [name]
    if re.search(r"\band\b", name, re.I):
        bases.append(re.sub(r"\band\b", "&", name, flags=re.I))
    if "&" in name:
        bases.append(collapse(re.sub(r"\s*&\s*", f" {word} ", name)))
        bases.append(name.replace("&", word))
    out = []
    for b in bases:
        for v in (b, b.lower(), b.upper()):
            if v != name and v not in out:
                out.append(v)
    return out


def parse_variations(v):
    return [p.strip() for p in cell_str(v).split("|") if p.strip()]


def parse_notes(v):
    s = cell_str(v).strip()
    if s.startswith("["):
        return "\n".join(parse_list(s))
    return s


def read_table(filename, raw):
    if filename.lower().endswith(".csv"):
        text = raw.decode("utf-8-sig", errors="replace")
        return [row for row in csv.reader(io.StringIO(text))]
    wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    ws = wb.active
    return [list(r) for r in ws.iter_rows(values_only=True)]


def parse_upload(filename, raw):
    table = read_table(filename, raw)

    header_idx = None
    for i, row in enumerate(table[:15]):
        if any(norm_header(c) == "partyname" for c in row):
            header_idx = i
            break
    if header_idx is None:
        raise ValueError("Couldn't find a header row with a 'partyName' column.")

    headers = table[header_idx]
    col, header_map = {}, {}
    for field, aliases in FIELDS.items():
        for j, h in enumerate(headers):
            if norm_header(h) in aliases and j not in col.values():
                col[field] = j
                header_map[field] = str(h).strip()
                break

    def get(row, field):
        j = col.get(field)
        return row[j] if j is not None and j < len(row) else None

    rows = []
    for raw_row in table[header_idx + 1:]:
        if not any(cell_str(c).strip() for c in raw_row):
            continue
        original = {
            "phoneNumbers": parse_list(get(raw_row, "phoneNumbers")),
            "createdBys": parse_list(get(raw_row, "createdBys")),
            "partyName": cell_str(get(raw_row, "partyName")),
            "name_variations": parse_variations(get(raw_row, "name_variations")),
            "industry": cell_str(get(raw_row, "industry")).strip(),
            "partyTypes": [p.upper() for p in parse_list(get(raw_row, "partyTypes"))],
            "notes": parse_notes(get(raw_row, "notes")),
        }
        rows.append(new_row(len(rows), original))
    if not rows:
        raise ValueError("The file has a header row but no data rows.")
    return rows, header_map


def new_row(row_id, original):
    """One queue entry. `original` keeps what came in; `current` is what the reviewer edits."""
    return {
        "id": row_id,
        "original": original,
        "current": {k: (list(v) if isinstance(v, list) else v)
                    for k, v in original.items()
                    if k not in ("phoneNumbers", "createdBys")},
        "status": "pending",
        "updated_at": None,
    }


# ---------------------------------------------------------------- state

# Settings that belong to each person rather than the team. They live in config.local.json (git ignores it),
# so a pull never overwrites them and changing them never blocks a pull. Everything else is shared.
PERSONAL_DEFAULTS = {
    "publish.dry_run": True,
    "publish.auto": False,
    "publish.auto_delay_seconds": 10,
    "databricks.token_file": "",
    "prefetch_next": True,
    "handoff_on_flag": True,
    "handoff_default": "",
    "queue.extend_lookback": True,
    "queue.max_lookback_days": 365,
    "edit_shared": False,
}
_MISSING = object()


def get_path(d, path, default=_MISSING):
    for k in path.split("."):
        if not isinstance(d, dict) or k not in d:
            return default
        d = d[k]
    return d


def set_path(d, path, value):
    keys = path.split(".")
    for k in keys[:-1]:
        if not isinstance(d.get(k), dict):
            d[k] = {}
        d = d[k]
    d[keys[-1]] = value


def drop_path(d, path):
    keys = path.split(".")
    for k in keys[:-1]:
        d = d.get(k) if isinstance(d, dict) else None
        if not isinstance(d, dict):
            return
    d.pop(keys[-1], None)


def _read_json(path):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def split_config(cfg):
    """(shared part, personal part) of a full config."""
    shared = json.loads(json.dumps(cfg))
    personal = {}
    for p in PERSONAL_DEFAULTS:
        v = get_path(cfg, p)
        if v is not _MISSING:
            set_path(personal, p, v)
        drop_path(shared, p)
    for k in [k for k, v in shared.items() if v == {}]:
        shared.pop(k)
    return shared, personal


def load_config():
    """The shared config.json with this computer's personal settings (config.local.json) laid over it."""
    cfg = _read_json(CONFIG_FILE)
    local = _read_json(LOCAL_CONFIG_FILE)
    for p, default in PERSONAL_DEFAULTS.items():
        v = get_path(local, p)
        if v is _MISSING:
            v = get_path(cfg, p, default)  # older single-file configs kept these in config.json
        set_path(cfg, p, v)
    if not cfg.get("team") and cfg.get("teammates"):  # the old plain list of emails
        cfg["team"] = [{"name": str(e).split("@")[0], "email": e} for e in cfg["teammates"]]
    return cfg


def migrate_local_config():
    """First run of this version: move your personal settings out of config.json into config.local.json."""
    if os.path.exists(LOCAL_CONFIG_FILE) or not os.path.exists(CONFIG_FILE):
        return
    _, personal = split_config(load_config())
    write_json(LOCAL_CONFIG_FILE, personal)


def write_json(path, data, backup=False):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    if backup and os.path.exists(path):
        with open(path, encoding="utf-8") as src, open(path + ".bak", "w", encoding="utf-8") as bak:
            bak.write(src.read())
    os.replace(tmp, path)


def app_version():
    """VERSION file plus the git commit, read straight from .git so it works without git on the PATH."""
    ver = ""
    try:
        with open(os.path.join(BASE_DIR, "VERSION"), encoding="utf-8") as f:
            ver = f.read().strip()
    except OSError:
        pass
    commit = ""
    try:
        gd = os.path.join(BASE_DIR, ".git")
        with open(os.path.join(gd, "HEAD"), encoding="utf-8") as f:
            head = f.read().strip()
        if head.startswith("ref:"):
            ref = head[4:].strip()
            rp = os.path.join(gd, *ref.split("/"))
            if os.path.exists(rp):
                with open(rp, encoding="utf-8") as f:
                    commit = f.read().strip()
            elif os.path.exists(os.path.join(gd, "packed-refs")):
                with open(os.path.join(gd, "packed-refs"), encoding="utf-8") as f:
                    commit = next((ln.split()[0] for ln in f if ln.strip().endswith(" " + ref)), "")
        else:
            commit = head
    except OSError:
        pass
    return {"version": ver, "commit": commit[:7], "git": os.path.isdir(os.path.join(BASE_DIR, ".git"))}


def load_state():
    if not os.path.exists(STATE_FILE):
        return {"filename": None, "rows": [], "header_map": {}}
    with open(STATE_FILE, encoding="utf-8") as f:
        return json.load(f)


def save_state(state):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=1)
    os.replace(tmp, STATE_FILE)


def clean_current(c):
    def str_list(v, upper=False):
        out = []
        for x in v or []:
            s = str(x).strip()
            if s:
                out.append(s.upper() if upper else s)
        return out
    return {
        "partyName": str(c.get("partyName", "")),
        "name_variations": str_list(c.get("name_variations")),
        "industry": str(c.get("industry", "")),
        "partyTypes": str_list(c.get("partyTypes"), upper=True),
        "notes": str(c.get("notes", "")),
    }


# ---------------------------------------------------------------- routes

@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/state")
def get_state():
    with _lock:
        state = load_state()
    return jsonify({**state, "config": load_config()})


@app.post("/api/upload")
def upload():
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="No file received."), 400
    if not f.filename.lower().endswith((".xlsx", ".xlsm", ".csv")):
        return jsonify(error="Upload an .xlsx or .csv file."), 400
    try:
        rows, header_map = parse_upload(f.filename, f.read())
    except Exception as e:  # noqa: BLE001 - show any parse problem to the user
        return jsonify(error=f"Couldn't read that file: {e}"), 400
    with _lock:
        previous = load_state()
    if previous.get("claim_batch"):  # leaving a Databricks queue: give its unfinished names back
        try:
            DB.write_file("claims_release_mine", **claim_fmt())
        except Exception as e:  # noqa: BLE001 - they'll expire on their own
            print("Couldn't release claims:", e)
    state = {
        "filename": f.filename,
        "uploaded_at": datetime.now().isoformat(timespec="seconds"),
        "header_map": header_map,
        "rows": rows,
    }
    with _lock:
        save_state(state)
    return jsonify({**state, "config": load_config()})


@app.put("/api/rows/<int:row_id>")
def update_row(row_id):
    payload = request.get_json(silent=True) or {}
    with _lock:
        state = load_state()
        if row_id < 0 or row_id >= len(state["rows"]):
            return jsonify(error="No such row."), 404
        row = state["rows"][row_id]
        if row.get("published"):
            return jsonify(error="This row is already published to Databricks, so it can't be changed here."), 409
        if row.get("released"):
            return jsonify(error="This row was released for someone else to pick up, so it can't be changed here."), 409
        if row.get("handed_off"):
            return jsonify(error="This row was handed to someone else, so it can't be changed here."), 409
        if "current" in payload or "status" in payload:
            row.pop("publish_error", None)
        if "current" in payload:
            row["current"] = clean_current(payload["current"])
        if payload.get("status") in STATUSES:
            row["status"] = payload["status"]
        row["updated_at"] = datetime.now().isoformat(timespec="seconds")
        save_state(state)
    return jsonify(row)


@app.post("/api/reset")
def reset():
    with _lock:
        if os.path.exists(STATE_FILE):
            os.remove(STATE_FILE)
    return jsonify(ok=True)


# ---------------------------------------------------------------- Databricks (read-only)

DB = Databricks(load_config().get("databricks"), BASE_DIR)  # settings changes are applied by DB.reconfigure()
DEFAULT_TABLES = {
    "mcl": "analysts.mcl.master_table",
    "denied": "analysts.mcl.denied_new_to_mcl",
    "honeypot": "analysts.rhenderson.honeypot_callback_lookup",
    "industry_mapping": "analysts.datatools.industry_mapping",
    "change_log": "analysts.rhenderson.mcl_change_log",
    "claims": "analysts.rhenderson.mcl_queue_claims",
    "handoffs": "analysts.rhenderson.mcl_handoffs",
}


def tbl(key):
    return DB.table(key, DEFAULT_TABLES[key])


# ---------------------------------------------------------------- settings (config.json)

CODE_RE = re.compile(r"^[A-Z0-9]{1,4}$")
TABLE_RE = re.compile(r"^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,2}$")  # catalog.schema.table; goes into SQL, so strict


def clean_config(c):
    """Validate and normalise a config from the settings window. Raises ValueError listing every problem."""
    if not isinstance(c, dict):
        raise ValueError("Settings must be a JSON object.")
    problems = []
    out = dict(c)  # keep keys this function doesn't know about

    def codes(v, where):
        if not isinstance(v, list):
            problems.append(f"{where} must be a list of codes.")
            return []
        res = []
        for x in v:
            x = str(x).strip().upper()
            if not CODE_RE.match(x):
                problems.append(f"{where}: “{x}” isn't a valid code (1–4 letters/digits).")
            elif x not in res:
                res.append(x)
        return res

    pts = c.get("partytypes", {})
    if not isinstance(pts, dict) or not pts:
        problems.append("Party types can't be empty.")
        pts = {}
    out["partytypes"] = {}
    for k, label in pts.items():
        code = str(k).strip().upper()
        if not CODE_RE.match(code):
            problems.append(f"Party type “{k}” isn't a valid code (1–4 letters/digits).")
        out["partytypes"][code] = str(label or "").strip()

    inds = c.get("industries", {})
    if not isinstance(inds, dict) or not inds:
        problems.append("The industry list can't be empty.")
        inds = {}
    out["industries"] = {}
    for name, v in inds.items():
        name = collapse(name)
        if not name:
            problems.append("An industry has no name.")
            continue
        defaults = v.get("default_partytypes", []) if isinstance(v, dict) else v
        out["industries"][name] = {"default_partytypes": codes(defaults, f"Defaults for {name}")}

    for key, label in (("filterable", "Call Guard list"), ("upload_allowed_partytypes", "Upload-allowed list")):
        if key in c:
            out[key] = codes(c[key], label)

    ids = c.get("industry_ids", {})
    if not isinstance(ids, dict):
        problems.append("industry_ids must be an object of name → number.")
    else:
        out["industry_ids"] = {}
        for k, v in ids.items():
            try:
                out["industry_ids"][collapse(k)] = int(v)
            except (TypeError, ValueError):
                problems.append(f"Industry id for “{k}” must be a number.")

    doms = c.get("aggregator_domains", [])
    if isinstance(doms, str):
        doms = doms.split()
    out["aggregator_domains"] = sorted({re.sub(r"^(https?://)?(www\.)?", "", str(d).strip().lower()).strip("/")
                                        for d in doms if str(d).strip()})

    name = str(c.get("csv_filename", "New-to-MCL.csv")).strip()
    if not name or re.search(r'[\\/:*?"<>|]', name):
        problems.append("The CSV file name is empty or has characters Windows doesn't allow.")
    out["csv_filename"] = name
    sep = str(c.get("csv_variation_separator", "|"))
    if not sep or sep == ",":
        problems.append("The variation separator can't be empty or a comma (commas separate the CSV columns' party types).")
    out["csv_variation_separator"] = sep

    lnt = str(c.get("lnt_base", "")).strip().rstrip("/")
    if not re.match(r"^https?://[^\s/]+", lnt):
        problems.append("The LNT address must start with https://")
    out["lnt_base"] = lnt
    out["prefetch_next"] = bool(c.get("prefetch_next", True))

    pub = c.get("publish") if isinstance(c.get("publish"), dict) else {}
    schema = str(pub.get("sandbox_schema") or "analysts.rhenderson").strip()
    if not re.match(r"^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$", schema):
        problems.append(f"The test schema (“{schema}”) should look like catalog.schema.")
    try:
        delay = int(pub.get("auto_delay_seconds", 10))
    except (TypeError, ValueError):
        delay = -1
    if not 3 <= delay <= 120:
        problems.append("The undo window must be between 3 and 120 seconds.")
    out["publish"] = {**pub, "dry_run": bool(pub.get("dry_run", True)), "sandbox_schema": schema,
                      "auto": bool(pub.get("auto", False)), "auto_delay_seconds": delay}
    claims = c.get("claims") if isinstance(c.get("claims"), dict) else {}
    try:
        hours = int(claims.get("expire_hours", 24))
    except (TypeError, ValueError):
        hours = -1
    if not 1 <= hours <= 168:
        problems.append("Claims must expire after 1 to 168 hours.")
    out["claims"] = {**claims, "expire_hours": hours}
    out["handoff_on_flag"] = bool(c.get("handoff_on_flag", True))
    out["edit_shared"] = bool(c.get("edit_shared", False))
    team, seen = [], set()
    raw_team = c.get("team")
    if raw_team is None and c.get("teammates"):
        raw_team = [{"email": e} for e in c.get("teammates") or []]
    for m in raw_team or []:
        m = m if isinstance(m, dict) else {"email": m}
        email = str(m.get("email") or "").strip().lower()
        name = collapse(m.get("name") or "")
        if not email and not name:
            continue
        if not EMAIL_RE.match(email):
            problems.append(f"Team: “{email or name}” needs a valid Databricks login email.")
            continue
        if email not in seen:
            seen.add(email)
            team.append({"name": name or short_user(email), "email": email})
    out["team"] = team
    out.pop("teammates", None)
    hd = str(c.get("handoff_default") or "").strip().lower()
    if hd and not EMAIL_RE.match(hd):
        problems.append(f"The default person to pass flags to (“{hd}”) should be an email.")
    out["handoff_default"] = hd
    q = c.get("queue") if isinstance(c.get("queue"), dict) else {}
    try:
        max_days = int(q.get("max_lookback_days", 365))
    except (TypeError, ValueError):
        max_days = -1
    if not 30 <= max_days <= 4400:
        problems.append("Look back at most between 30 and 4400 days (the history starts in 2015).")
    out["queue"] = {**q, "extend_lookback": bool(q.get("extend_lookback", True)), "max_lookback_days": max_days}

    dbc = c.get("databricks", {})
    if not isinstance(dbc, dict):
        problems.append("databricks must be an object.")
        dbc = {}
    host = re.sub(r"^https?://", "", str(dbc.get("hostname", "")).strip()).rstrip("/")
    path = str(dbc.get("http_path", "")).strip()
    if path and not path.startswith("/sql/"):
        problems.append("The Databricks HTTP path should look like /sql/1.0/warehouses/…")
    tables = dbc.get("tables", {}) if isinstance(dbc.get("tables"), dict) else {}
    clean_tables = {}
    for key, default in DEFAULT_TABLES.items():
        t = str(tables.get(key) or default).strip()
        if not TABLE_RE.match(t):
            problems.append(f"Table name for {key} (“{t}”) should look like catalog.schema.table.")
        clean_tables[key] = t
    out["databricks"] = {**dbc, "hostname": host, "http_path": path,
                         "token_file": str(dbc.get("token_file", "")).strip(), "tables": clean_tables}

    if problems:
        raise ValueError(" ".join(problems))
    return out


SECTION_NAMES = {"industries": "industries", "industry_ids": "industry ids", "partytypes": "party types",
                 "filterable": "Call Guard list", "upload_allowed_partytypes": "upload-allowed list",
                 "aggregator_domains": "listing sites", "databricks": "Databricks connection or tables",
                 "publish": "test schema", "claims": "claims", "team": "team list", "queue": "queue settings"}


def config_meta():
    return {"personal": list(PERSONAL_DEFAULTS), "local_file": os.path.basename(LOCAL_CONFIG_FILE), **app_version()}


@app.get("/api/config")
def get_config():
    return jsonify({**load_config(), "_meta": config_meta()})


@app.put("/api/config")
def put_config():
    body = request.get_json(silent=True)
    if isinstance(body, dict):
        body.pop("_meta", None)
        body.pop("shared_changed", None)
    try:
        cfg = clean_config(body)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    new_shared, new_personal = split_config(cfg)
    with _lock:
        try:
            cur_shared, _ = split_config(clean_config(load_config()))
        except ValueError:
            cur_shared = split_config(load_config())[0]
        changed = sorted(k for k in set(new_shared) | set(cur_shared) if new_shared.get(k) != cur_shared.get(k))
        if changed and not cfg["edit_shared"]:
            what = ", ".join(dict.fromkeys(SECTION_NAMES.get(k, k) for k in changed))
            return jsonify(error=f"Nothing saved: you changed shared settings ({what}). Those come from config.json in the "
                                 "team repo, so the next update would clash with them. Discard those changes, or ask "
                                 "whoever maintains the repo. If that's you, tick “I maintain the shared settings” "
                                 "on the Team tab first."), 403
        write_json(LOCAL_CONFIG_FILE, new_personal)
        if changed:
            write_json(CONFIG_FILE, new_shared, backup=True)
    cfg = load_config()
    DB.reconfigure(cfg.get("databricks"))
    return jsonify({**cfg, "_meta": config_meta(), "shared_changed": bool(changed)})


@app.get("/api/db/industry-stats")
def db_industry_stats():
    """How the MCL actually classifies each industry: its most common party-type sets."""
    try:
        rows = DB.query_file("industry_stats", mcl_table=tbl("mcl"))
    except Exception as e:  # noqa: BLE001
        return db_error(e)
    by_ind = {}
    for r in rows:
        ind = cell_str(r.get("industry_name")).strip()
        pts = [p for p in cell_str(r.get("pts")).split(",") if p]
        by_ind.setdefault(ind, []).append({"types": pts, "n": int(r.get("n") or 0)})
    out = {}
    for ind, sets in by_ind.items():
        sets.sort(key=lambda x: -x["n"])
        out[ind] = {"total": sum(x["n"] for x in sets), "top": sets[:3]}
    return jsonify(out)


@app.get("/api/db/industry-mapping")
def db_industry_mapping():
    """The official industry list (name → id) the batch notebook joins against."""
    try:
        rows = DB.query_file("industry_mapping", mapping_table=tbl("industry_mapping"))
    except Exception as e:  # noqa: BLE001
        return db_error(e)
    return jsonify([{"name": cell_str(r.get("industry_name")).strip(), "id": int(r.get("industry_id"))}
                    for r in rows if r.get("industry_id") is not None and cell_str(r.get("industry_name")).strip()])


# ---------------------------------------------------------------- publishing

PUBLISH_LOG = os.path.join(DATA_DIR, "publish_log.jsonl")
_publish_lock = threading.Lock()  # one test/publish at a time (a double-click must not write twice)


def all_tables():
    return {k: tbl(k) for k in DEFAULT_TABLES}


def current_plan():
    with _lock:
        state = load_state()
    return state, publish.build_plan(state, load_config(), DB, all_tables(), final_values, collapse)


def plan_for_client(plan):
    return {k: v for k, v in plan.items() if k not in ("mcl_payload", "denied_payload")}


@app.post("/api/publish/preview")
def publish_preview():
    """Dry run: what publishing would do right now. Reads Databricks, writes nothing."""
    try:
        _, plan = current_plan()
    except Exception as e:  # noqa: BLE001
        return db_error(e)
    cfg = load_config()
    return jsonify({**plan_for_client(plan), "dry_run": cfg["publish"]["dry_run"] if "publish" in cfg else True,
                    "tables": all_tables()})


def _run(mode):
    want = (request.get_json(silent=True) or {}).get("plan_id")
    if not _publish_lock.acquire(blocking=False):
        return jsonify(error="A test or publish is already running."), 409
    try:
        try:
            state, plan = current_plan()
        except Exception as e:  # noqa: BLE001
            return db_error(e)
        if plan["plan_id"] != want:
            return jsonify(error="Something changed since the preview (your edits or the MCL itself). "
                                 "Preview again before continuing.", stale=True), 409
        if not plan["writes"]:
            return jsonify(error="Nothing to write."), 400
        cfg = load_config()
        result = publish.run_plan(plan, mode, cfg, DB, all_tables(), user=DB.whoami() if mode == "test" else "")

        if mode == "publish":
            finish_publish(plan, result)
        publish.append_local_log(PUBLISH_LOG, plan, result)
        return jsonify({**result, "plan": plan_for_client(plan)})
    finally:
        _publish_lock.release()


def finish_publish(plan, result):
    """After a real publish: lock the rows that made it in, mark their claims done, write the change log."""
    done = {it["row_id"]: it for it in plan["items"]
            if it["action"] in ("insert", "merge", "deny", "skip")
            and ((it["kind"] == "mcl" and result["mcl_ok"]) or (it["kind"] == "denied" and result["denied_ok"]))}
    with _lock:
        state = load_state()
        for r in state["rows"]:
            it = done.get(r["id"])
            if it and not r.get("published"):
                target = it.get("target") or (it["after"]["partyname"] if it.get("after") else it["name"])
                r["published"] = {"at": result["at"], "run_id": result["run_id"], "action": it["action"],
                                  "kind": it["kind"], "target": target}
                r.pop("publish_error", None)
        save_state(state)
    result["state_rows"] = state["rows"]
    for r in state["rows"]:
        if r["id"] in done and r.get("handoff"):
            err = close_handoff(r["handoff"]["id"], f"Finished: {HANDOFF_DONE.get(done[r['id']]['action'], 'published')}")
            if err:
                result["warnings"].append(f"Published, but couldn't close the handoff ({err}).")
    if state.get("claim_batch") and done:
        err = set_claims("done", [r["original"]["partyName"] for r in state["rows"] if r["id"] in done])
        if err:
            result["warnings"].append(f"Published, but couldn't mark the names done in the claims table ({err}).")
    try:
        publish.write_remote_log(DB, publish.log_entries(plan, result, all_tables()), tbl("change_log"))
    except Exception as e:  # noqa: BLE001
        result["warnings"].append(f"Published, but couldn't write the Databricks change log ({e}). "
                                  "The local log has the details.")


@app.post("/api/publish/row/<int:row_id>")
def publish_row(row_id):
    """Publish one row straight away (publish-on-approve). A row with problems is bounced back
    to Flagged with the reason instead of being written."""
    cfg = load_config()
    if (cfg.get("publish") or {}).get("dry_run", True):
        return jsonify(error="Dry run mode is on, so nothing was published."), 403
    if not _publish_lock.acquire(timeout=120):
        return jsonify(error="Another publish is taking too long. Try again in a moment."), 409
    try:
        with _lock:
            state = load_state()
        try:
            plan = publish.build_plan(state, cfg, DB, all_tables(), final_values, collapse, only_ids={row_id})
        except Exception as e:  # noqa: BLE001
            return db_error(e)
        if not plan["items"]:
            return jsonify(error="That row isn't approved or denied, or it's already done."), 400
        item = plan["items"][0]

        if item["action"] == "problem":
            with _lock:
                state = load_state()
                row = state["rows"][row_id]
                row["status"] = "flagged"
                row["publish_error"] = " ".join(item["problems"])
                save_state(state)
            return jsonify(published=False, row=row, problems=item["problems"])

        if plan["writes"]:
            result = publish.run_plan(plan, "publish", cfg, DB, all_tables())
        else:  # already up to date / already denied: nothing to write, just mark it done
            result = {"mode": "publish", "run_id": uuid.uuid4().hex[:12], "at": datetime.now().isoformat(timespec="seconds"),
                      "mcl": None, "denied": None, "mcl_ok": True, "denied_ok": True, "errors": [], "warnings": [], "verify": []}
        if result["errors"]:
            with _lock:
                state = load_state()
                row = state["rows"][row_id]
                row["status"] = "flagged"
                row["publish_error"] = "Couldn't publish: " + " ".join(result["errors"])
                save_state(state)
            publish.append_local_log(PUBLISH_LOG, plan, result)
            return jsonify(published=False, row=row, errors=result["errors"])
        finish_publish(plan, result)
        publish.append_local_log(PUBLISH_LOG, plan, result)
        row = next(r for r in result["state_rows"] if r["id"] == row_id)
        return jsonify(published=True, row=row, action=item["action"], target=item.get("target"),
                       warnings=result["warnings"], verify=result["verify"])
    finally:
        _publish_lock.release()


@app.post("/api/publish/test")
def publish_test():
    """Run the real SQL against shallow clones of the MCL and denied tables, then verify."""
    return _run("test")


@app.post("/api/publish/run")
def publish_run():
    cfg = load_config()
    if (cfg.get("publish") or {}).get("dry_run", True):
        return jsonify(error="Dry run mode is on. Turn it off in Settings → Publishing to publish for real."), 403
    return _run("publish")


@app.get("/api/publish/log")
def publish_log():
    runs = publish.read_local_log(PUBLISH_LOG)
    size = os.path.getsize(PUBLISH_LOG) if os.path.exists(PUBLISH_LOG) else 0
    return jsonify(runs=runs, size=size, path=PUBLISH_LOG)


@app.get("/api/publish/log/download")
def publish_log_download():
    if not os.path.exists(PUBLISH_LOG):
        return jsonify(error="The local log is empty."), 404
    return send_file(PUBLISH_LOG, as_attachment=True, download_name="mcl_publish_log.jsonl", mimetype="application/json")


@app.delete("/api/publish/log")
def publish_log_clear():
    with _lock:
        if os.path.exists(PUBLISH_LOG):
            os.remove(PUBLISH_LOG)
    return jsonify(ok=True)


# ---------------------------------------------------------------- MCL editor

def editor_table():
    return "denied" if request.args.get("table", (request.get_json(silent=True) or {}).get("table")) == "denied" else "mcl"


@app.get("/api/editor/search")
def editor_search():
    term = collapse(request.args.get("q", ""))
    if len(term) < 3:
        return jsonify(error="Type at least 3 letters."), 400
    esc_term = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    try:
        if editor_table() == "denied":
            rows = [editor.denied_entry(r) for r in DB.query_file(
                "editor_search_denied", [f"%{esc_term}%", f"%{esc_term}%"], denied_table=tbl("denied"))]
        else:
            rows = [mcl_row(r) for r in DB.query_file(
                "mcl_search", [f"%{esc_term}%", f"%{esc_term}%", term, f"{esc_term}%"], mcl_table=tbl("mcl"))]
    except Exception as e:  # noqa: BLE001
        return db_error(e)
    return jsonify(items=rows)


@app.get("/api/editor/entry")
def editor_entry():
    name = request.args.get("name", "")
    try:
        rows, fp = editor.get(DB, all_tables(), editor_table(), name)
        hist, hist_err = editor.history(DB, all_tables(), name)
    except Exception as e:  # noqa: BLE001
        return db_error(e)
    if not rows:
        return jsonify(error=f"“{name}” wasn't found."), 404
    return jsonify(entry=rows[0], duplicates=len(rows), fingerprint=fp, history=hist, history_error=hist_err)


def _editor_writes_allowed():
    if (load_config().get("publish") or {}).get("dry_run", True):
        return jsonify(error="Dry run mode is on, so nothing was changed. Turn it off in Settings → Publishing."), 403
    return None


@app.post("/api/editor/preview")
def editor_preview():
    b = request.get_json(silent=True) or {}
    try:
        before, after, changes, problems, fp = editor.plan_edit(DB, all_tables(), load_config(), b.get("key", ""), b.get("after") or {})
    except Exception as e:  # noqa: BLE001
        return db_error(e)
    return jsonify(before=before, after=after, changes=changes, problems=problems, fingerprint=fp)


@app.post("/api/editor/save")
def editor_save():
    b = request.get_json(silent=True) or {}
    blocked = _editor_writes_allowed()
    if blocked:
        return blocked
    reason = collapse(b.get("reason", ""))
    if len(reason) < 3:
        return jsonify(error="Add a reason for the change (e.g. “audit challenge, ticket 123”)."), 400
    with _publish_lock:
        try:
            res = editor.save(DB, all_tables(), load_config(), b.get("key", ""), b.get("after") or {}, reason, b.get("fingerprint"))
        except Exception as e:  # noqa: BLE001
            return db_error(e)
    if res.get("error"):
        return jsonify(res), 409 if res.get("stale") else 400
    return jsonify(res)


@app.post("/api/editor/delete")
def editor_delete():
    b = request.get_json(silent=True) or {}
    blocked = _editor_writes_allowed()
    if blocked:
        return blocked
    key = b.get("key", "")
    reason = collapse(b.get("reason", ""))
    if len(reason) < 3:
        return jsonify(error="Add a reason first."), 400
    table = "denied" if b.get("table") == "denied" else "mcl"
    if table == "mcl" and b.get("confirm") != key:
        return jsonify(error="Type the entry's exact name to confirm deleting it."), 400
    with _publish_lock:
        try:
            res = editor.delete(DB, all_tables(), table, key, reason, b.get("fingerprint"))
        except Exception as e:  # noqa: BLE001
            return db_error(e)
    if res.get("error"):
        return jsonify(res), 409 if res.get("stale") else 400
    return jsonify(res)


# ---------------------------------------------------------------- handoffs ("Ask someone")

EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
HANDOFF_DONE = {"insert": "added to the MCL", "merge": "merged into an existing MCL entry",
                "deny": "added to the denied list", "skip": "already up to date"}
_handoff_lock = threading.Lock()


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _handoff(hid):
    rows = DB.query_file("handoff_get", [hid], handoffs_table=tbl("handoffs"))
    if not rows:
        return None
    h = dict(rows[0])
    h["row"] = json.loads(h.get("row_json") or "{}")
    h["thread"] = json.loads(h.get("thread_json") or "[]")
    return h


def _save_handoff(h, assignee, status):
    DB.write_file("handoff_update", [assignee, status, json.dumps(h["row"]), json.dumps(h["thread"]), h["handoff_id"]],
                  handoffs_table=tbl("handoffs"))


def close_handoff(hid, text):
    """Mark a handoff done once its row is published. Best effort: returns an error message or None."""
    try:
        with _handoff_lock:
            h = _handoff(hid)
            if not h or h.get("status") == "done":
                return None
            me = DB.whoami()
            h["thread"].append({"by": short_user(me), "email": me, "at": _now(), "text": text, "kind": "done"})
            _save_handoff(h, me, "done")
        return None
    except Exception as e:  # noqa: BLE001
        print("Couldn't close handoff:", e)
        return str(e)


def handoff_summary(h):
    last = h["thread"][-1] if h["thread"] else {}
    return {"id": h["handoff_id"], "partyname": cell_str(h.get("partyname")), "from": short_user(h.get("from_user")),
            "last_by": last.get("by"), "last_text": last.get("text"), "updated": cell_str(h.get("updated_at"))[:16],
            "count": len(h["thread"])}


@app.get("/api/handoff/people")
def handoff_people():
    """Teammates to hand to: the team list in Settings, plus everyone else who has used the app."""
    cfg = load_config()
    names = {m["email"]: m.get("name") or short_user(m["email"]) for m in cfg.get("team") or [] if m.get("email")}
    people = set(names)
    try:
        ensure_claims()
        people |= {cell_str(r.get("person")) for r in DB.query_file("handoff_people", **claim_fmt())}
        me = DB.whoami()
    except Exception as e:  # noqa: BLE001
        return db_error(e)
    people.discard(me)
    return jsonify(people=sorted((p for p in people if EMAIL_RE.match(p)), key=lambda p: (p not in names, p)),
                   names=names, default=cfg.get("handoff_default") or "")


@app.get("/api/handoff/inbox")
def handoff_inbox():
    try:
        ensure_claims()
        rows = DB.query_file("handoff_inbox", handoffs_table=tbl("handoffs"))
    except Exception as e:  # noqa: BLE001
        return db_error(e)
    out = []
    for r in rows:
        h = dict(r)
        h["thread"] = json.loads(h.get("thread_json") or "[]")
        out.append(handoff_summary(h))
    return jsonify(items=out)


@app.post("/api/handoff/send")
def handoff_send():
    """Hand a row to someone (or send a handed-to-me row back / on). It leaves my queue."""
    b = request.get_json(silent=True) or {}
    note = collapse(b.get("note", ""))[:2000] or ("Flagged for a second look." if b.get("flag") else "")
    to = str(b.get("to") or "").strip().lower()
    if not note:
        return jsonify(error="Add a note so they know what you need."), 400
    with _lock:
        state = load_state()
        rows = state["rows"]
        row = rows[b.get("row_id")] if isinstance(b.get("row_id"), int) and 0 <= b["row_id"] < len(rows) else None
    if not row or row.get("published") or row.get("released") or row.get("handed_off"):
        return jsonify(error="That row is finished here, so it can't be handed off."), 400
    try:
        ensure_claims()
        me = DB.whoami()
        with _handoff_lock:
            existing = _handoff(row["handoff"]["id"]) if row.get("handoff") else None
            if existing and existing.get("status") == "open":
                if not to:  # "send back": to whoever sent it to me last
                    to = next((t.get("email") for t in reversed(existing["thread"]) if t.get("email") and t["email"] != me),
                              existing.get("from_user"))
                hid = existing["handoff_id"]
                existing["row"] = {"original": row["original"], "current": row["current"]}
                existing["thread"].append({"by": short_user(me), "email": me, "at": _now(), "text": note, "to": short_user(to)})
                if not EMAIL_RE.match(to or "") or to == me:
                    return jsonify(error="Pick who to send it to."), 400
                _save_handoff(existing, to, "open")
            else:
                if not EMAIL_RE.match(to) or to == me:
                    return jsonify(error="Pick a teammate's email to send it to."), 400
                hid = uuid.uuid4().hex[:12]
                thread = [{"by": short_user(me), "email": me, "at": _now(), "text": note, "to": short_user(to)}]
                DB.write_file("handoff_insert", [hid, collapse(row["original"]["partyName"]), to,
                                                 json.dumps({"original": row["original"], "current": row["current"]}),
                                                 json.dumps(thread)], handoffs_table=tbl("handoffs"))
    except Exception as e:  # noqa: BLE001
        return db_error(e)
    if state.get("claim_batch") and not row.get("handoff"):
        set_claims("handed_off", [row["original"]["partyName"]])  # the open handoff keeps it out of everyone's queue
    with _lock:
        state = load_state()
        r = state["rows"][row["id"]]
        r["handed_off"] = {"to": short_user(to), "at": _now(), "id": hid, "note": note}
        r["status"] = "flagged"
        save_state(state)
    return jsonify(row=r)


@app.post("/api/handoff/take")
def handoff_take():
    """Pull a handoff from my inbox into my queue, with the sender's edits and notes."""
    hid = (request.get_json(silent=True) or {}).get("id", "")
    try:
        h = _handoff(hid)
        me = DB.whoami()
    except Exception as e:  # noqa: BLE001
        return db_error(e)
    if not h or h.get("status") != "open" or h.get("assignee") != me:
        return jsonify(error="That handoff isn't waiting on you any more."), 409
    info = {"id": hid, "from": short_user(h.get("from_user")), "thread": h["thread"]}
    with _lock:
        state = load_state()
        if not state.get("rows"):
            state = {"filename": "Handed to me", "uploaded_at": _now(), "header_map": {}, "rows": []}
        row = next((r for r in state["rows"]
                    if (r.get("handoff") or {}).get("id") == hid or (r.get("handed_off") or {}).get("id") == hid), None)
        if row is None:
            row = new_row(len(state["rows"]), h["row"].get("original") or {})
            state["rows"].append(row)
        row["current"] = clean_current(h["row"].get("current") or row["current"])
        row.pop("handed_off", None)
        row.pop("published", None)
        row["status"] = "pending"
        row["handoff"] = info
        save_state(state)
    return jsonify({**state, "config": load_config(), "row_id": row["id"]})


# ---------------------------------------------------------------- Stats

# fixed SQL for each period (the time zone is a parameter; "today" etc. are local days)
STATS_SINCE = {
    "today": "to_date(from_utc_timestamp(current_timestamp(), ?))",
    "week": "date_trunc('week', from_utc_timestamp(current_timestamp(), ?))",
    "month": "date_trunc('month', from_utc_timestamp(current_timestamp(), ?))",
    "all": "date'1970-01-01' and ? is not null",
}


@app.get("/api/stats")
def stats():
    period = request.args.get("period") if request.args.get("period") in STATS_SINCE else "week"
    tz = load_config().get("timezone") or "America/Chicago"
    try:
        rows = DB.query_file("stats", [tz, tz], log_table=tbl("change_log"), since=STATS_SINCE[period])
        daily = DB.query_file("stats_daily", [tz, tz, tz, tz], log_table=tbl("change_log"))
        me = short_user(DB.whoami())
    except Exception as e:  # noqa: BLE001
        # Unity Catalog can report a missing permission as "not found", so always show the real message
        msg = str(e)
        hint = (" Databricks says \"not found\" both when a table doesn't exist yet (nothing published) and when you're "
                "missing USE CATALOG / USE SCHEMA / SELECT on it. Settings → Connections → Check my access shows which."
                ) if "not found" in msg.lower() or "TABLE_OR_VIEW" in msg else ""
        return jsonify(error=f"Couldn't read the change log ({tbl('change_log')}): {msg.rstrip('.')}.{hint}"), 502
    users = {}
    for r in rows:
        u = users.setdefault(cell_str(r.get("user")), {"user": cell_str(r.get("user"))})
        u[cell_str(r.get("action"))] = int(r.get("n") or 0)
    out = sorted(users.values(), key=lambda u: -(u.get("insert", 0) + u.get("merge", 0) + u.get("deny", 0)))
    return jsonify(period=period, me=me, timezone=tz, users=out,
                   daily=[{"day": cell_str(r.get("day"))[:10], "user": cell_str(r.get("user")), "n": int(r.get("n") or 0)}
                          for r in daily])


# ---------------------------------------------------------------- Add to MCL

def _claimed_by_other(name):
    try:
        ensure_claims()
        hit = DB.query_file("claims_lookup", [name], **claim_fmt())
        return short_user(hit[0].get("claimed_by")) if hit else None
    except Exception:  # noqa: BLE001 - a nice-to-have warning
        return None


def _phones(raw):
    nums = [re.sub(r"\D", "", p)[-10:] for p in re.split(r"[\s,;|]+", str(raw or ""))]
    return [n for n in dict.fromkeys(nums) if len(n) == 10][:200]


@app.post("/api/add/preview")
def add_preview():
    b = request.get_json(silent=True) or {}
    try:
        after, problems, warnings = editor.plan_add(DB, all_tables(), load_config(), b.get("entry") or {}, _claimed_by_other)
    except Exception as e:  # noqa: BLE001
        return db_error(e)
    return jsonify(after=after, problems=problems, warnings=warnings, phones=_phones(b.get("phones")))


@app.post("/api/add/save")
def add_save():
    b = request.get_json(silent=True) or {}
    blocked = _editor_writes_allowed()
    if blocked:
        return blocked
    with _publish_lock:
        try:
            res = editor.add(DB, all_tables(), load_config(), b.get("entry") or {}, collapse(b.get("reason", "")),
                             _phones(b.get("phones")), _claimed_by_other)
        except Exception as e:  # noqa: BLE001
            return db_error(e)
    if res.get("error"):
        return jsonify(res), 400
    return jsonify(res)


@app.get("/api/db/check")
def db_check():
    """Can I read each table the app uses? Reports the exact Databricks message for any that fail."""
    tables = {**all_tables(), "queue source": "analysts.research_metrics.v_pnvl_history"}
    out = []
    try:
        me = DB.whoami()
    except Exception as e:  # noqa: BLE001
        return db_error(e)
    for key, t in tables.items():
        try:
            DB.query(f"select 1 as ok from {t} limit 1")
            out.append({"key": key, "table": t, "ok": True})
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            out.append({"key": key, "table": t, "ok": False, "error": msg[:400],
                        "missing": "TABLE_OR_VIEW" in msg or "not found" in msg.lower()})
    return jsonify(user=me, tables=out)


def db_error(e):
    print("Databricks error:", e)
    return jsonify(error=f"Databricks: {e}"), 502


@app.get("/api/db/status")
def db_status():
    return jsonify(installed=DB.installed, configured=DB.configured, connected=DB.connected,
                   last_error=DB.last_error)


@app.post("/api/db/connect")
def db_connect():
    """First call opens the Databricks sign-in page in your browser (only when there's no saved token)."""
    try:
        DB.query("select 1 as ok")
    except Exception as e:  # noqa: BLE001
        return db_error(e)
    return db_status()


QUEUE_ORDERS = {
    "any": "",                                          # fastest: whatever Databricks returns first
    "most_seen": "order by entries desc, partyName",    # names entered most often first
    "newest": "order by last_seen desc",                # most recently seen first
    "az": "order by partyName",
}


def queue_filters(f):
    """Turn the start screen's filters into SQL snippets + parameters. Raises ValueError on bad input.
    The snippets are fixed text; only the parameters carry what you typed."""
    f = f or {}
    try:
        days = int(60 if f.get("days") in (None, "") else f.get("days"))
        min_seen = int(1 if f.get("min_seen") in (None, "") else f.get("min_seen"))
    except (TypeError, ValueError):
        raise ValueError("Days and “seen at least” must be whole numbers.")
    if not 1 <= days <= 4400:
        raise ValueError("Look back between 1 and 4400 days (the history starts in 2015).")
    if not 1 <= min_seen <= 1000:
        raise ValueError("“Seen at least” must be between 1 and 1000.")
    industries = [collapse(x) for x in (f.get("industries") or []) if collapse(x)][:50]
    name = collapse(f.get("name") or "")[:100]
    people = [p for p in re.split(r"[\s,;]+", str(f.get("created_by") or "").lower()) if p][:20]
    if any(not re.match(r"^[a-z0-9._@-]+$", p) for p in people):
        raise ValueError("“Entered by” should be LNT usernames separated by commas.")
    order = f.get("order") if f.get("order") in QUEUE_ORDERS else "any"

    # parameters must be listed in the order their ? appear in the query
    where, params = [], []
    if name:
        esc_name = name.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        where.append("and a.partyName ilike ?")
        params.append(f"%{esc_name}%")
    if people:
        where.append("and lower(a.createdBy) in (select explode(from_json(?, 'array<string>')))")
        params.append(json.dumps(people))
    having = ""
    if min_seen > 1:
        having = "having count(*) >= ?"
        params.append(min_seen)
    industry_filter = ""
    if industries:
        industry_filter = "where array_max(industrys) in (select explode(from_json(?, 'array<string>')))"
        params.append(json.dumps(industries))
    fmt = {"days": days, "name_filter": "\n    ".join(where), "having": having,
           "industry_filter": industry_filter, "order_by": QUEUE_ORDERS[order]}
    return fmt, params


def queue_settings():
    q = load_config().get("queue") or {}
    return bool(q.get("extend_lookback", True)), int(q.get("max_lookback_days", 365))


LOOKBACK_STEPS = (30, 60, 90, 120, 180, 270, 365, 540, 730, 1095, 1460, 1825, 2555, 3650, 4380)


def lookback_steps(days, cap):
    """The look-back windows to consider, from the one you set up to the cap."""
    steps = [days] + [d for d in LOOKBACK_STEPS if days < d < cap] + ([cap] if cap > days else [])
    return sorted(set(steps))


def lookback_counts(filters, steps):
    """How many unclaimed names match within each look-back window, in one query over the widest one."""
    sql, params = queue_sql({**filters, "days": steps[-1]}, 10_000_000)
    cols = ", ".join(f"count_if(date(last_seen) >= current_date() - interval {int(d)} days) as d{int(d)}" for d in steps)
    rows = DB.query(f"select {cols} from (\n{sql}\n) q", params)
    r = rows[0] if rows else {}
    return {d: int(r.get(f"d{d}") or 0) for d in steps}


def queue_sql(filters, limit):
    fmt, params = queue_filters(filters)
    return DB.load_sql("new_to_mcl", mcl_table=tbl("mcl"), denied_table=tbl("denied"), limit=limit,
                       **claim_fmt(), **fmt), params


@app.post("/api/db/queue/count")
def db_queue_count():
    """How many unclaimed New-to-MCL names match the filters (nothing is claimed)."""
    filters = (request.get_json(silent=True) or {}).get("filters") or {}
    try:
        fmt, _ = queue_filters(filters)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    days = fmt["days"]
    extend, cap = queue_settings()
    try:
        ensure_claims()
        if extend and cap > days:  # one query gives the count at every look-back up to the cap
            counts = lookback_counts(filters, lookback_steps(days, cap))
            return jsonify(n=counts[days], days=days, buckets=[{"days": d, "n": n} for d, n in counts.items()])
        sql, params = queue_sql(filters, 10_000_000)
        rows = DB.query(f"select count(*) as n from (\n{sql}\n) q", params)
    except Exception as e:  # noqa: BLE001
        return db_error(e)
    return jsonify(n=int(rows[0]["n"]) if rows else 0, days=days, buckets=[])


@app.post("/api/db/queue")
def db_queue():
    """Replace the current queue with a fresh New-to-MCL pull from Databricks."""
    payload = request.get_json(silent=True) or {}
    try:
        limit = max(1, min(int(payload.get("limit", 1023)), 5000))
    except (TypeError, ValueError):
        limit = 1023
    filters = payload.get("filters") or {}
    try:
        queue_filters(filters)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    batch = uuid.uuid4().hex[:12]
    try:
        ensure_claims()
        DB.write_file("claims_release_mine", **claim_fmt())  # give back what's left of your previous queue
        # Claim, and if someone loading at the same moment beat us to some names, top up from what's
        # still free (the query skips everyone's active claims, including the ones we just won).
        results, lost = [], 0
        requested_days = queue_filters(filters)[0]["days"]
        extend, cap = queue_settings()
        used_days, counted = requested_days, False
        for _ in range(8):
            need = limit - len(results)
            if need <= 0:
                break
            sql, params = queue_sql({**filters, "days": used_days}, need)
            batch_rows = [r for r in DB.query(sql, params) if cell_str(r.get("partyName")).strip()]
            if batch_rows:
                wanted = [{"partyname": cell_str(r.get("partyName")).strip(), "phone_numbers": to_list(r.get("phoneNumbers"))}
                          for r in batch_rows]
                DB.write_file("claims_claim", [json.dumps(wanted), batch], **claim_fmt())
                won = {cell_str(r.get("partyname")).strip() for r in DB.query_file("claims_mine", [batch], **claim_fmt())}
                kept = [r for r in batch_rows if cell_str(r.get("partyName")).strip() in won]
                results += kept
                lost += len(batch_rows) - len(kept)
                if len(kept) < len(batch_rows):
                    continue  # someone beat us to some: top up from the same window
            if len(batch_rows) >= need:
                continue
            # This window has run dry. Look further back, just far enough to fill the request (up to the cap).
            if not extend or used_days >= cap or counted:
                break
            counted = True  # one count query covers every wider window
            still = limit - len(results)
            counts = lookback_counts(filters, lookback_steps(used_days, cap))
            # names in a wider window include the ones we already hold, so compare against what's left
            base = counts.get(used_days, 0)
            used_days = next((d for d, n in counts.items() if d > used_days and n - base >= still), cap)
        user = DB.whoami()
    except Exception as e:  # noqa: BLE001
        return db_error(e)

    cfg = load_config()
    defaults = {k: (v or {}).get("default_partytypes") or [] for k, v in (cfg.get("industries") or {}).items()}
    cutoff = (datetime.now().date() - timedelta(days=requested_days)).isoformat()
    rows = []
    for r in results:
        name = cell_str(r.get("partyName")).strip()
        if not name:
            continue
        industry = cell_str(r.get("industry")).strip()
        # the query's hard-coded guesses are replaced by your Settings defaults where you have them
        party_types = defaults.get(industry) or [p.upper() for p in to_list(r.get("partytypes"))]
        rows.append(new_row(len(rows), {
            "phoneNumbers": to_list(r.get("phoneNumbers")),
            "createdBys": to_list(r.get("createdBys")),
            "partyName": name,
            # whatever the query generated, plus every spelling it should have (in case the query is an older copy)
            "name_variations": list(dict.fromkeys(parse_variations(r.get("name_variations")) + name_variants(name))),
            "industry": industry,
            "partyTypes": list(party_types),
            "notes": "\n".join(n for n in to_list(r.get("Notes")) if n.strip()),
            "seen": int(r.get("entries") or 0) or None,
            "last_seen": cell_str(r.get("last_seen"))[:10] or None,
            # from beyond the look-back you set (the app reached further back to fill your request)
            "older": bool(cell_str(r.get("last_seen"))[:10] and cell_str(r.get("last_seen"))[:10] < cutoff),
        }))
    if not rows:
        msg = "No unclaimed New-to-MCL names match those filters."
        if lost:
            msg = f"All {lost} names were claimed by someone else a moment ago. Try loading again."
        return jsonify(error=msg), 404

    state = {
        "filename": f"Databricks queue {datetime.now():%b %d %H:%M}",
        "uploaded_at": datetime.now().isoformat(timespec="seconds"),
        "header_map": {},
        "rows": rows,
        "claim_batch": batch,
        "claimed_by": user,
        "filters": filters,
    }
    with _lock:
        save_state(state)
    return jsonify({**state, "config": load_config(), "claims": {"won": len(rows), "lost": lost},
                    "lookback": {"requested": requested_days, "used": used_days,
                                 "within_requested": sum(1 for r in rows if not r["original"].get("older"))}})


# ---------------------------------------------------------------- claims (multiplayer)

_claims_ready = set()


def claim_hours():
    try:
        return max(1, min(int((load_config().get("claims") or {}).get("expire_hours", 24)), 168))
    except (TypeError, ValueError):
        return 24


def claim_fmt():
    return {"claims_table": tbl("claims"), "claim_hours": claim_hours(), "handoffs_table": tbl("handoffs")}


def ensure_claims():
    """The shared claims and handoffs tables (created on first use)."""
    for key, sql, fmt in (("claims", "claims_create", "claims_table"), ("handoffs", "handoff_create", "handoffs_table")):
        t = tbl(key)
        if t not in _claims_ready:
            DB.write_file(sql, **{fmt: t})
            _claims_ready.add(t)


def set_claims(status, names):
    """Mark your claims on these names done or released. Best effort: a failure only means they expire later."""
    names = sorted({collapse(n) for n in names if collapse(n)})
    if not names:
        return None
    try:
        ensure_claims()
        DB.write_file("claims_set_status", [status, json.dumps(names)], **claim_fmt())
        return None
    except Exception as e:  # noqa: BLE001
        print("Couldn't update claims:", e)
        return str(e)


def short_user(u):
    return str(u or "").split("@")[0]


@app.post("/api/claims/heartbeat")
def claims_heartbeat():
    with _lock:
        state = load_state()
    if not state.get("claim_batch"):
        return jsonify(ok=True, skipped=True)
    try:
        ensure_claims()
        DB.write_file("claims_heartbeat", **claim_fmt())
    except Exception as e:  # noqa: BLE001
        return db_error(e)
    return jsonify(ok=True)


@app.get("/api/claims/others")
def claims_others():
    try:
        ensure_claims()
        rows = DB.query_file("claims_others", **claim_fmt())
        me = DB.whoami()
    except Exception as e:  # noqa: BLE001
        return db_error(e)
    return jsonify(me=short_user(me), others=[{"user": short_user(r.get("claimed_by")), "n": int(r.get("n") or 0)}
                                              for r in rows])


@app.post("/api/claims/release")
def claims_release():
    """Give rows back to the pool so someone else can pick them up."""
    ids = set((request.get_json(silent=True) or {}).get("row_ids") or [])
    with _lock:
        state = load_state()
        rows = [r for r in state["rows"] if r["id"] in ids and not r.get("published") and not r.get("released")]
    if not state.get("claim_batch"):
        return jsonify(error="This queue wasn't loaded from Databricks, so there's nothing to release."), 400
    err = set_claims("released", [r["original"]["partyName"] for r in rows])
    if err:
        return jsonify(error=f"Couldn't release: {err}"), 502
    with _lock:
        state = load_state()
        now = datetime.now().isoformat(timespec="seconds")
        for r in state["rows"]:
            if r["id"] in {x["id"] for x in rows}:
                r["released"] = {"at": now}
        save_state(state)
    return jsonify(rows=state["rows"])


def mcl_row(r):
    return {
        "partyname": cell_str(r.get("partyname")),
        "industry": cell_str(r.get("industry_name")),
        "partytypes": to_list(r.get("partytypes")),
        "name_variations": to_list(r.get("name_variations")),
        "insertDate": cell_str(r.get("insertDate")) or None,
        "modifyDate": cell_str(r.get("modifyDate")) or None,
    }


@app.get("/api/db/mcl/match")
def db_mcl_match():
    """Already in the MCL (would be an update) and/or denied before?"""
    name = collapse(request.args.get("name", ""))
    if not name:
        return jsonify(error="No name given."), 400
    try:
        mcl = DB.query_file("mcl_match", [name, name], mcl_table=tbl("mcl"))
        denied = DB.query_file("denied_match", [name, name], denied_table=tbl("denied"))
    except Exception as e:  # noqa: BLE001
        return db_error(e)
    claimed_by = None
    try:
        ensure_claims()
        hit = DB.query_file("claims_lookup", [name], **claim_fmt())
        claimed_by = short_user(hit[0].get("claimed_by")) if hit else None
    except Exception as e:  # noqa: BLE001 - the claim check is a nice-to-have
        print("Claim lookup failed:", e)
    return jsonify(name=name, mcl=[mcl_row(r) for r in mcl],
                   denied=[cell_str(r.get("partyname")) for r in denied], claimed_by=claimed_by)


@app.get("/api/db/mcl/search")
def db_mcl_search():
    term = collapse(request.args.get("q", ""))
    if len(term) < 3:
        return jsonify(error="Type at least 3 letters."), 400
    esc = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    try:
        rows = DB.query_file("mcl_search", [f"%{esc}%", f"%{esc}%", term, f"{esc}%"], mcl_table=tbl("mcl"))
    except Exception as e:  # noqa: BLE001
        return db_error(e)
    return jsonify(term=term, items=[mcl_row(r) for r in rows])


@app.get("/api/db/honeypot/<number>")
def db_honeypot(number):
    digits = re.sub(r"\D", "", number)[-10:]
    if len(digits) != 10:
        return jsonify(error="Invalid phone number."), 400
    try:
        rows = DB.query_file("honeypot", [digits], honeypot_table=tbl("honeypot"))
    except Exception as e:  # noqa: BLE001
        return db_error(e)
    return jsonify(number=digits, matches=[{
        "date": cell_str(r.get("dt")) or None,
        "callTimestamp": cell_str(r.get("callTimestamp")) or None,
        "aNumber": cell_str(r.get("aNumber")),
        "transcript": cell_str(r.get("transcript")),
    } for r in rows])


def select_rows(rows, scope):
    """approved: Approved only. all: everything except Denied. denied: Denied only. everything: every row."""
    if scope == "approved":
        return [r for r in rows if r["status"] == "approved"]
    if scope == "all":
        return [r for r in rows if r["status"] != "denied"]
    if scope == "denied":
        return [r for r in rows if r["status"] == "denied"]
    return list(rows)


def final_values(r):
    """The cleaned values that leave the tool, shared by the CSV and the Excel review copy."""
    o, c = r["original"], r["current"]
    name = collapse(c["partyName"])
    variations, have = [], set()
    for v in c["name_variations"]:
        v = v.strip()
        if v and v not in have:
            variations.append(v)
            have.add(v)
    # Renamed? Keep every form of the old name so it still links to this caller.
    old_name = collapse(o["partyName"])
    if old_name and name != old_name:
        have_c = {collapse(v) for v in variations}
        for v in [old_name, old_name.lower(), old_name.upper()] + [collapse(x) for x in o["name_variations"]]:
            if v and v not in have_c:
                variations.append(v)
                have_c.add(v)
    party_types = []
    for p in c["partyTypes"]:
        p = p.strip().upper()
        if p and p not in party_types:
            party_types.append(p)
    changed = [k for k in ("partyName", "name_variations", "industry", "partyTypes", "notes")
               if (sorted(c[k]) != sorted(o[k]) if k == "partyTypes" else c[k] != o[k])]
    return {
        "partyName": name,
        "name_variations": variations,
        "industry": collapse(c["industry"]),
        "partyTypes": party_types,
        "notes": [n.strip() for n in c["notes"].splitlines() if n.strip()],
        "changed": changed,
    }


@app.get("/export/csv")
def export_csv():
    """The upload file for the Databricks batch notebook:
    partyname,industry,partytypes,name_variations with partytypes as CS,EN,OB and pipe-separated variations."""
    scope = request.args.get("scope", "approved")
    cfg = load_config()
    with _lock:
        state = load_state()
    rows = select_rows(state["rows"], scope)
    sep = cfg.get("csv_variation_separator", "|")

    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")  # quotes cells that contain commas, e.g. "CS,EN,OB"
    w.writerow(["partyname", "industry", "partytypes", "name_variations"])
    for r in rows:
        v = final_values(r)
        w.writerow([v["partyName"], v["industry"], ",".join(v["partyTypes"]), sep.join(v["name_variations"])])

    name = cfg.get("csv_filename", "New-to-MCL.csv")
    if scope == "denied":
        stem, ext = os.path.splitext(name)
        name = f"{stem}-denied{ext}"
    # No BOM: Spark would read it into the first header and the notebook's `partyname` column would break.
    return send_file(io.BytesIO(buf.getvalue().encode("utf-8")), as_attachment=True,
                     download_name=name, mimetype="text/csv")


@app.get("/export/xlsx")
@app.get("/export")
def export_xlsx():
    """Review copy: every original column plus status, with edited cells highlighted."""
    scope = request.args.get("scope", "everything")
    with _lock:
        state = load_state()
    rows = select_rows(state["rows"], scope)

    hm = {**DEFAULT_HEADERS, **state.get("header_map", {})}
    wb = Workbook()
    ws = wb.active
    ws.title = "verified"
    ws.append([hm[k] for k in EXPORT_ORDER] + ["status", "changed"])
    for cell in ws[1]:
        cell.font = Font(bold=True)
    changed_fill = PatternFill("solid", fgColor="FFF2B3")

    def compact(lst):
        return json.dumps(lst, separators=(",", ":"))

    for r in rows:
        o, v = r["original"], final_values(r)
        values = {
            "phoneNumbers": compact(o["phoneNumbers"]),
            "createdBys": compact(o["createdBys"]),
            "partyName": v["partyName"],
            "name_variations": "|".join(v["name_variations"]),
            "industry": v["industry"],
            "partyTypes": compact(v["partyTypes"]),
            "notes": compact(v["notes"]),
        }
        ws.append([values[k] for k in EXPORT_ORDER] + [r["status"], ", ".join(v["changed"])])
        for k in v["changed"]:
            ws.cell(row=ws.max_row, column=EXPORT_ORDER.index(k) + 1).fill = changed_fill

    widths = [16, 14, 34, 60, 18, 22, 30, 10, 30]
    for i, wdt in enumerate(widths, start=1):
        ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = wdt
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = Alignment(vertical="top", wrap_text=True)
    ws.freeze_panes = "A2"

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    stem = os.path.splitext(state.get("filename") or "mcl")[0]
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    return send_file(buf, as_attachment=True,
                     download_name=f"{stem}_review_{stamp}.xlsx",
                     mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


if __name__ == "__main__":
    migrate_local_config()
    v = app_version()
    print(f"YaMCL {v['version'] or ''} {('(' + v['commit'] + ')') if v['commit'] else ''}".rstrip())
    port = int(os.environ.get("PORT", 5050))
    print(f"YaMCL running at http://127.0.0.1:{port}")
    app.run(host="127.0.0.1", port=port, debug=False)
