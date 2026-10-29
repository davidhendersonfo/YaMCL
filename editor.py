"""MCL editor: change, delete or un-deny existing entries, one at a time.

Every save goes preview -> save. The preview returns a fingerprint of the entry as it was when you
looked at it; save refuses if the entry changed since (someone else edited it), re-validates,
writes one statement, reads the entry back to verify, and logs before/after with your reason.
"""
import hashlib
import json
import uuid
from datetime import datetime

from db import to_list


def _s(v):
    return "" if v is None else str(v)


def _collapse(s):
    return " ".join(_s(s).split())


def _uniq(seq):
    out = []
    for x in seq:
        if x and x not in out:
            out.append(x)
    return out


def mcl_entry(r):
    return {
        "partyname": _s(r.get("partyname")),
        "industry": _s(r.get("industry_name")),
        "industryId": r.get("industryId"),
        "partytypes": to_list(r.get("partytypes")),
        "name_variations": to_list(r.get("name_variations")),
        "insertDate": _s(r.get("insertDate")) or None,
        "modifyDate": _s(r.get("modifyDate")) or None,
    }


def denied_entry(r):
    return {
        "partyname": _s(r.get("partyname")),
        "industry": _s(r.get("industry")),
        "partytypes": to_list(r.get("partytypes")),
        "name_variations": to_list(r.get("name_variations")),
    }


def fingerprint(rows):
    return hashlib.sha256(json.dumps(rows, sort_keys=True, default=str).encode()).hexdigest()[:16]


def get(db, tables, table, name):
    """The entry (or entries: an exact duplicate name is possible in old data) plus its fingerprint."""
    if table == "denied":
        rows = [denied_entry(r) for r in db.query_file("editor_get_denied", [name], denied_table=tables["denied"])]
    else:
        rows = [mcl_entry(r) for r in db.query_file("editor_get", [name], mcl_table=tables["mcl"])]
    return rows, fingerprint(rows)


def history(db, tables, name):
    try:
        rows = db.query_file("editor_history", [name, name], log_table=tables["change_log"])
    except Exception as e:  # noqa: BLE001 - no change log yet is normal before the first publish
        if "not found" in str(e).lower() or "TABLE_OR_VIEW" in str(e):
            return [], None
        return [], str(e)
    out = []
    for r in rows:
        out.append({
            "at": _s(r.get("logged_at"))[:16], "by": _s(r.get("changed_by")).split("@")[0],
            "action": _s(r.get("action")), "table": _s(r.get("target_table")), "partyname": _s(r.get("partyname")),
            "before": json.loads(r["before_json"]) if r.get("before_json") else None,
            "after": json.loads(r["after_json"]) if r.get("after_json") else None,
            "reason": _s(r.get("reason")),
        })
    return out, None


def plan_edit(db, tables, cfg, key, proposed):
    """Validate a proposed MCL edit. Returns (before, after, changes, problems, fingerprint)."""
    rows, fp = get(db, tables, "mcl", key)
    problems, changes = [], []
    if not rows:
        return None, None, [], [f"“{key}” isn't in the MCL any more."], fp
    if len(rows) > 1:
        problems.append(f"There are {len(rows)} MCL entries named exactly “{key}”. Saving would change all of them; "
                        "clean the duplicate up first (delete one).")
    before = rows[0]

    name = _collapse(proposed.get("partyname"))
    industry = _collapse(proposed.get("industry"))
    allowed = set(cfg.get("upload_allowed_partytypes") or [])
    pts = _uniq([_s(p).strip().upper() for p in proposed.get("partytypes") or []])
    variations = _uniq([_s(v).strip() for v in proposed.get("name_variations") or []])

    if len(name) <= 2:
        problems.append("Names of 2 characters or fewer fail the MCL checks.")
    renamed = name != before["partyname"]
    if renamed:
        old = before["partyname"]
        # same rule as the review queue: the old name keeps linking to this entry
        variations = _uniq(variations + [old, old.lower(), old.upper()])
        variations = [v for v in variations if v != name]
        clash = [m for m in db.query_file("publish_lookup_mcl", [json.dumps([name])], mcl_table=tables["mcl"])
                 if _s(m.get("partyname")) != before["partyname"]]
        if clash:
            problems.append(f"“{name}” already belongs to another MCL entry (“{_s(clash[0].get('partyname'))}”).")

    mapping = {_s(m.get("industry_name")).strip(): m.get("industry_id")
               for m in db.query_file("industry_mapping", mapping_table=tables["industry_mapping"])}
    if industry not in mapping:
        problems.append(f"“{industry or '(blank)'}” isn't in the industry mapping table.")
    if not pts:
        problems.append("No party types.")
    bad = [p for p in pts if allowed and p not in allowed]
    if bad:
        problems.append(f"Party types not allowed in the MCL: {', '.join(bad)}.")

    after = {"partyname": name, "industry": industry, "industryId": mapping.get(industry),
             "partytypes": pts, "name_variations": variations}
    if renamed:
        changes.append(f"Name: {before['partyname']} → {name} (the old name stays as a variation)")
    if industry != before["industry"]:
        changes.append(f"Industry: {before['industry'] or '(none)'} → {industry}")
    if pts != before["partytypes"]:
        changes.append(f"Party types: {','.join(before['partytypes']) or '(none)'} → {','.join(pts) or '(none)'}")
    added = [v for v in variations if v not in before["name_variations"]]
    removed = [v for v in before["name_variations"] if v not in variations]
    if added:
        changes.append("Adds variations: " + " | ".join(added))
    if removed:
        changes.append("Removes variations: " + " | ".join(removed))
    if not changes:
        problems.append("Nothing changed.")
    return before, after, changes, problems, fp


def _log(db, tables, action, table_key, before, after, reason):
    entry = {"run_id": uuid.uuid4().hex[:12], "action": action, "target_table": tables[table_key],
             "partyname": (after or before)["partyname"], "phone_numbers": [],
             "before_json": json.dumps(before, default=str) if before else None,
             "after_json": json.dumps(after, default=str) if after else None,
             "reason": reason[:1000]}
    db.write_file("log_create", log_table=tables["change_log"])
    db.write_file("log_insert", [json.dumps([entry])], log_table=tables["change_log"])


def save(db, tables, cfg, key, proposed, reason, fp_seen):
    before, after, changes, problems, fp = plan_edit(db, tables, cfg, key, proposed)
    if fp != fp_seen:
        return {"stale": True, "error": "Someone changed this entry since you opened it. Reload it and redo your edit."}
    if problems:
        return {"error": " ".join(problems)}
    db.write_file("editor_update", [after["partyname"], after["industry"], after["industryId"],
                                    json.dumps(after["partytypes"]), json.dumps(after["name_variations"]), key],
                  mcl_table=tables["mcl"])
    rows, _ = get(db, tables, "mcl", after["partyname"])
    verify = []
    if len(rows) != 1:
        verify.append(f"Expected 1 entry named “{after['partyname']}” after saving, found {len(rows)}.")
    else:
        got = rows[0]
        for k in ("industry", "partytypes", "name_variations"):
            same = sorted(got[k]) == sorted(after[k]) if isinstance(after[k], list) else got[k] == after[k]
            if not same:
                verify.append(f"{k} didn't save as expected.")
    warnings = []
    try:
        _log(db, tables, "edit", "mcl", before, {**after, "insertDate": before.get("insertDate"),
                                                  "modifyDate": datetime.now().date().isoformat()}, reason)
    except Exception as e:  # noqa: BLE001
        warnings.append(f"Saved, but couldn't write the change log: {e}")
    return {"ok": True, "entry": rows[0] if rows else after, "changes": changes, "verify": verify, "warnings": warnings}


def delete(db, tables, table, key, reason, fp_seen):
    rows, fp = get(db, tables, table, key)
    if not rows:
        return {"error": f"“{key}” isn't there any more."}
    if fp != fp_seen:
        return {"stale": True, "error": "Someone changed this entry since you opened it. Reload it first."}
    db.write_file("editor_undeny" if table == "denied" else "editor_delete", [key],
                  **({"denied_table": tables["denied"]} if table == "denied" else {"mcl_table": tables["mcl"]}))
    left, _ = get(db, tables, table, key)
    warnings = []
    try:
        _log(db, tables, "undeny" if table == "denied" else "delete", table, rows[0], None, reason)
    except Exception as e:  # noqa: BLE001
        warnings.append(f"Done, but couldn't write the change log: {e}")
    return {"ok": not left, "error": None if not left else "It's still there after deleting.", "warnings": warnings}


# ---------------------------------------------------------------- Add to MCL (new entries by hand)

def plan_add(db, tables, cfg, proposed, claims_lookup=None):
    """Validate a new entry, like the manual-insert notebook. Returns (after, problems, warnings)."""
    name = _collapse(proposed.get("partyname"))
    industry = _collapse(proposed.get("industry"))
    allowed = set(cfg.get("upload_allowed_partytypes") or [])
    pts = _uniq([_s(p).strip().upper() for p in proposed.get("partytypes") or []])
    variations = [v for v in _uniq([_s(v).strip() for v in proposed.get("name_variations") or []]) if v != name]
    problems, warnings = [], []

    if not name:
        problems.append("A party name is required.")
    elif len(name) <= 2:
        problems.append("Names of 2 characters or fewer fail the MCL checks.")
    if name:
        # the notebook's two checks (exact name, exact variation) plus the queue's case-insensitive one
        owners = set()
        for m in db.query_file("publish_lookup_mcl", [json.dumps([name])], mcl_table=tables["mcl"]):
            existing = _s(m.get("partyname"))
            owners.add(existing)
            if existing == name:
                problems.append(f"“{name}” is already in the MCL.")
            elif name in to_list(m.get("name_variations")):
                problems.append(f"“{name}” is already a name variation of “{existing}”. Edit that entry instead.")
            else:
                problems.append(f"The MCL already has “{existing}”, which only differs in capitalization or spacing.")
        others = [v for v in variations if v.lower() != name.lower()]
        if others:
            hits = {}
            for m in db.query_file("publish_lookup_mcl", [json.dumps(others)], mcl_table=tables["mcl"]):
                hits.setdefault(_s(m.get("lookup_name")), _s(m.get("partyname")))
            for v, owner in hits.items():
                if owner not in owners:  # already reported above
                    warnings.append(f"The variation “{v}” already points to “{owner}”.")
        if db.query_file("publish_lookup_denied", [json.dumps([name])], denied_table=tables["denied"]):
            warnings.append("This name is on the denied list. Adding it is fine if that denial was wrong; "
                            "you can also remove it from the denied list in the MCL editor.")
        if claims_lookup:
            who = claims_lookup(name)
            if who:
                warnings.append(f"{who} has this name in their review queue right now.")

    mapping = {_s(m.get("industry_name")).strip(): m.get("industry_id")
               for m in db.query_file("industry_mapping", mapping_table=tables["industry_mapping"])}
    if industry not in mapping:
        problems.append(f"“{industry or '(blank)'}” isn't in the industry mapping table.")
    if not pts:
        problems.append("Pick at least one party type.")
    bad = [p for p in pts if allowed and p not in allowed]
    if bad:
        problems.append(f"Party types not allowed in the MCL: {', '.join(bad)}.")

    after = {"partyname": name, "industry": industry, "industryId": mapping.get(industry),
             "partytypes": pts, "name_variations": variations}
    return after, _uniq(problems), warnings


def add(db, tables, cfg, proposed, reason, phones, claims_lookup=None):
    after, problems, warnings = plan_add(db, tables, cfg, proposed, claims_lookup)
    if problems:
        return {"error": " ".join(problems)}
    name = after["partyname"]
    res = db.write_file("add_insert", [name, after["industry"], after["industryId"], json.dumps(after["partytypes"]),
                                       json.dumps(after["name_variations"]), name, name], mcl_table=tables["mcl"])
    inserted = int((res[0] if res else {}).get("num_inserted_rows") or 0)
    if not inserted:
        return {"error": f"Nothing was added: “{name}” showed up in the MCL just now (someone else may have added it)."}
    rows, _ = get(db, tables, "mcl", name)
    verify = [] if len(rows) == 1 else [f"Expected 1 entry named “{name}” after adding, found {len(rows)}."]
    try:
        entry = {"run_id": uuid.uuid4().hex[:12], "action": "insert", "target_table": tables["mcl"], "partyname": name,
                 "phone_numbers": phones, "before_json": None,
                 "after_json": json.dumps({**after, "insertDate": datetime.now().date().isoformat(), "modifyDate": None}),
                 "reason": (reason or "Added by hand")[:1000]}
        db.write_file("log_create", log_table=tables["change_log"])
        db.write_file("log_insert", [json.dumps([entry])], log_table=tables["change_log"])
    except Exception as e:  # noqa: BLE001
        warnings.append(f"Added, but couldn't write the change log: {e}")
    return {"ok": True, "entry": rows[0] if rows else after, "verify": verify, "warnings": warnings}
