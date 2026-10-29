"""Publishing approved and denied rows from the review queue to Databricks.

Three steps, each safe to repeat:
  1. build_plan   - read-only. Works out, per row, exactly what would happen (insert / merge / skip)
                    and why anything is excluded. Its plan_id fingerprints the plan, so a publish can
                    refuse to run if anything changed since you looked at the preview.
  2. run_plan(mode="test")    - runs the real SQL against shallow clones of the tables, then reads
                    the results back and compares them with the preview.
  3. run_plan(mode="publish") - same SQL against the real tables, then verify and log.
"""
import hashlib
import json
import os
import re
import uuid
from datetime import datetime

from db import to_list


def _uniq(seq):
    out, seen = [], set()
    for x in seq:
        if x and x not in seen:
            out.append(x)
            seen.add(x)
    return out


def _norm(s):
    return " ".join(str(s or "").split()).lower()


def _sandbox_names(cfg, user=""):
    """Test copies are per person, so two people testing at once don't overwrite each other's."""
    schema = (cfg.get("publish") or {}).get("sandbox_schema") or "analysts.rhenderson"
    who = re.sub(r"[^a-z0-9]+", "_", str(user or "").split("@")[0].lower()).strip("_")
    suffix = f"_{who}" if who else ""
    return {"mcl": f"{schema}.mcl_verifier_sandbox_mcl{suffix}", "denied": f"{schema}.mcl_verifier_sandbox_denied{suffix}"}


# ---------------------------------------------------------------- 1. plan

def build_plan(state, cfg, db, tables, final_values, collapse, only_ids=None):
    rows = [r for r in state["rows"] if not r.get("published") and not r.get("released") and not r.get("ticketed")
            and not (r.get("ticket") or {}).get("closed")  # someone else already finished the ticket
            and (only_ids is None or r["id"] in only_ids)]
    approved = [r for r in rows if r["status"] == "approved"]
    denied = [r for r in rows if r["status"] == "denied"]
    allowed = set(cfg.get("upload_allowed_partytypes") or [])
    items = []

    # official industry list, exactly as the MERGE will join it
    mapping, dup_inds = {}, set()
    for m in db.query_file("industry_mapping", mapping_table=tables["industry_mapping"]):
        name = str(m.get("industry_name") or "").strip()
        if name in mapping and mapping[name] != m.get("industry_id"):
            dup_inds.add(name)
        mapping[name] = m.get("industry_id")

    # ---- approved -> MCL
    vals = {r["id"]: final_values(r) for r in approved}
    names = _uniq(v["partyName"] for v in vals.values())
    matches = {}
    if names:
        for m in db.query_file("publish_lookup_mcl", [json.dumps(names)], mcl_table=tables["mcl"]):
            entry = {
                "partyname": str(m.get("partyname") or ""),
                "industry": str(m.get("industry_name") or ""),
                "industryId": m.get("industryId"),
                "partytypes": to_list(m.get("partytypes")),
                "name_variations": to_list(m.get("name_variations")),
                "insertDate": str(m.get("insertDate") or "") or None,
                "modifyDate": str(m.get("modifyDate") or "") or None,
            }
            found = matches.setdefault(m.get("lookup_name"), [])
            if all(e["partyname"] != entry["partyname"] for e in found):
                found.append(entry)

    for r in approved:
        v = vals[r["id"]]
        name, ind, pts = v["partyName"], v["industry"], v["partyTypes"]
        item = {"row_id": r["id"], "kind": "mcl", "name": name, "phones": r["original"]["phoneNumbers"],
                "notes": v["notes"], "problems": [], "info": [], "changes": []}
        if len(name) <= 2:
            item["problems"].append("Names of 2 characters or fewer fail the MCL checks.")
        if ind not in mapping:
            item["problems"].append(f"“{ind or '(blank)'}” isn't in the industry mapping table.")
        elif ind in dup_inds:
            item["problems"].append(f"“{ind}” appears twice in the industry mapping table with different ids.")
        if not pts:
            item["problems"].append("No party types.")
        bad = [p for p in pts if allowed and p not in allowed]
        if bad:
            item["problems"].append(f"Party types not allowed in the MCL: {', '.join(bad)}.")

        found = matches.get(name, [])
        if len(found) > 1:
            item["problems"].append("Matches more than one MCL entry (" + ", ".join(f"“{e['partyname']}”" for e in found)
                                    + "). Clean those up in the MCL first.")
        elif found:
            ex = found[0]
            new_vars = _uniq(ex["name_variations"] + v["name_variations"] + ([name] if name != ex["partyname"] else []))
            added = [x for x in new_vars if x not in ex["name_variations"]]
            item.update(action="merge", target=ex["partyname"], before=ex, after={
                "partyname": ex["partyname"], "industry": ind, "industryId": mapping.get(ind),
                "partytypes": ex["partytypes"], "name_variations": new_vars})
            if added:
                item["changes"].append("Adds variations: " + " | ".join(added))
            if ind != ex["industry"]:
                item["changes"].append(f"Industry: {ex['industry'] or '(none)'} → {ind}")
            if sorted(pts) != sorted(ex["partytypes"]):
                item["info"].append(f"Party types stay {','.join(ex['partytypes']) or '(none)'}. Merges keep the existing ones "
                                    f"(you chose {','.join(pts)}).")
            if not item["changes"] and not item["problems"]:
                item.update(action="skip")
                item["info"].insert(0, "Already up to date in the MCL.")
        else:
            item.update(action="insert", target=None, before=None, after={
                "partyname": name, "industry": ind, "industryId": mapping.get(ind),
                "partytypes": pts, "name_variations": v["name_variations"]})
        if item["problems"]:
            item["action"] = "problem"
        items.append(item)

    # two rows can't merge into the same entry (the MERGE would fail), or insert the same name twice
    groups = {}
    for it in items:
        if it["action"] == "merge":
            groups.setdefault(("merge", it["target"]), []).append(it)
        elif it["action"] == "insert":
            groups.setdefault(("insert", _norm(it["name"])), []).append(it)
    for (kind, key), group in groups.items():
        if len(group) > 1:
            nums = [str(g["row_id"] + 1) for g in group]
            rows_txt = "Rows " + (" and ".join(nums) if len(nums) == 2 else ", ".join(nums[:-1]) + " and " + nums[-1])
            both = "both" if len(nums) == 2 else "all"
            for g in group:
                g["action"] = "problem"
                g["problems"].append(
                    f"{rows_txt} would {both} merge into “{key}”. Approve just one." if kind == "merge"
                    else f"{rows_txt} would {both} add “{g['name']}”. Approve just one.")

    # ---- denied -> denied list
    d_names = _uniq(collapse(r["original"]["partyName"]) for r in denied)
    already = set()
    if d_names:
        for m in db.query_file("publish_lookup_denied", [json.dumps(d_names)], denied_table=tables["denied"]):
            already.add(m.get("lookup_name"))
    seen = set()
    for r in denied:
        v = final_values(r)
        name = collapse(r["original"]["partyName"])
        item = {"row_id": r["id"], "kind": "denied", "name": name, "phones": r["original"]["phoneNumbers"],
                "notes": v["notes"], "problems": [], "info": [], "changes": [], "target": None, "before": None}
        if name in already:
            item.update(action="skip")
            item["info"].append("Already on the denied list.")
        elif _norm(name) in seen:
            item.update(action="skip")
            item["info"].append("Same name as another denied row.")
        else:
            seen.add(_norm(name))
            variations = _uniq([collapse(x) for x in r["original"]["name_variations"]] + v["name_variations"])
            item.update(action="deny", after={"partyname": name, "industry": v["industry"],
                                              "partytypes": v["partyTypes"], "name_variations": variations})
        items.append(item)

    items.sort(key=lambda it: it["row_id"])
    mcl_payload = [{"target": it["target"], "partyname": it["after"]["partyname"] if it["action"] == "insert" else it["name"],
                    "industry_name": it["after"]["industry"],
                    "partytypes": it["after"]["partytypes"],
                    "name_variations": it["after"]["name_variations"] if it["action"] == "insert"
                    else vals[it["row_id"]]["name_variations"]}
                   for it in items if it["action"] in ("insert", "merge")]
    denied_payload = [{"partyname": it["after"]["partyname"], "industry": it["after"]["industry"],
                       "partytypes": it["after"]["partytypes"], "name_variations": it["after"]["name_variations"]}
                      for it in items if it["action"] == "deny"]
    # fingerprint: what we'd write AND what the MCL looked like, so publish can refuse a stale preview
    fingerprint = json.dumps({"mcl": mcl_payload, "denied": denied_payload,
                              "before": [it["before"] for it in items if it["action"] == "merge"]},
                             sort_keys=True, default=str)
    counts = {a: sum(1 for it in items if it["action"] == a) for a in ("insert", "merge", "deny", "skip", "problem")}
    return {
        "plan_id": hashlib.sha256(fingerprint.encode()).hexdigest()[:16],
        "items": items, "counts": counts,
        "mcl_payload": mcl_payload, "denied_payload": denied_payload,
        "writes": len(mcl_payload) + len(denied_payload),
    }


# ---------------------------------------------------------------- 2/3. run

def _set(x):
    return sorted(set(x or []))


def _verify(plan, db, mcl_table, denied_table):
    """Read the affected rows back and compare with what the preview promised."""
    problems = []
    expected = [it for it in plan["items"] if it["action"] in ("insert", "merge")]
    if expected:
        names = _uniq(it["after"]["partyname"] for it in expected)
        got = {}
        for m in db.query_file("publish_readback_mcl", [json.dumps(names)], mcl_table=mcl_table):
            got.setdefault(str(m.get("partyname")), []).append(m)
        for it in expected:
            want, rows = it["after"], got.get(it["after"]["partyname"], [])
            if not rows:
                problems.append(f"“{want['partyname']}” isn't in the MCL after publishing.")
                continue
            if it["action"] == "insert" and len(rows) > 1:
                problems.append(f"“{want['partyname']}” is in the MCL {len(rows)} times.")
            r = rows[0]
            if str(r.get("industry_name")) != want["industry"]:
                problems.append(f"“{want['partyname']}”: industry is {r.get('industry_name')}, expected {want['industry']}.")
            if _set(to_list(r.get("partytypes"))) != _set(want["partytypes"]):
                problems.append(f"“{want['partyname']}”: party types are {to_list(r.get('partytypes'))}, expected {want['partytypes']}.")
            if _set(to_list(r.get("name_variations"))) != _set(want["name_variations"]):
                problems.append(f"“{want['partyname']}”: name variations don't match what the preview showed.")
    d_expected = [it for it in plan["items"] if it["action"] == "deny"]
    if d_expected:
        names = [it["name"] for it in d_expected]
        got = {str(m.get("partyname")) for m in db.query_file(
            "publish_readback_denied", [json.dumps(names)], denied_table=denied_table)}
        problems += [f"“{n}” isn't on the denied list after publishing." for n in names if n not in got]
    return problems


def _counts_note(result, plan):
    notes = []
    m = result.get("mcl") or {}
    if plan["mcl_payload"] and m:
        ins, upd = int(m.get("num_inserted_rows") or 0), int(m.get("num_updated_rows") or 0)
        if ins != plan["counts"]["insert"] or upd != plan["counts"]["merge"]:
            notes.append(f"The MCL reported {ins} inserted / {upd} updated; the preview expected "
                         f"{plan['counts']['insert']} / {plan['counts']['merge']}.")
    d = result.get("denied") or {}
    if plan["denied_payload"] and d:
        n = int(d.get("num_inserted_rows") or d.get("num_affected_rows") or 0)
        if n != plan["counts"]["deny"]:
            notes.append(f"The denied list reported {n} added; the preview expected {plan['counts']['deny']}.")
    return notes


def run_plan(plan, mode, cfg, db, tables, user=""):
    """mode: 'test' (shallow clones) or 'publish' (the real tables). Returns a result dict.
    The MCL MERGE runs first and is all-or-nothing; the denied-list insert runs second."""
    result = {"mode": mode, "run_id": uuid.uuid4().hex[:12], "at": datetime.now().isoformat(timespec="seconds"),
              "mcl": None, "denied": None, "mcl_ok": not plan["mcl_payload"], "denied_ok": not plan["denied_payload"],
              "errors": [], "warnings": [], "verify": []}
    mcl_table, denied_table = tables["mcl"], tables["denied"]

    if mode == "test":
        sb = _sandbox_names(cfg, user)
        result["sandbox"] = sb
        for key, source in (("mcl", tables["mcl"]), ("denied", tables["denied"])):
            try:
                db.write_file("sandbox_clone", sandbox_table=sb[key], source_table=source)
            except Exception as e:  # noqa: BLE001 - fall back to a plain copy
                try:
                    db.write_file("sandbox_copy", sandbox_table=sb[key], source_table=source)
                    result["warnings"].append(f"Couldn't shallow-clone {source}, used a full copy instead ({e}).")
                except Exception as e2:  # noqa: BLE001
                    result["errors"].append(f"Couldn't make a test copy of {source}: {e2}")
                    return result
        mcl_table, denied_table = sb["mcl"], sb["denied"]

    if plan["mcl_payload"]:
        try:
            rows = db.write_file("publish_mcl", [json.dumps(plan["mcl_payload"])],
                                 mcl_table=mcl_table, mapping_table=tables["industry_mapping"])
            result["mcl"] = {k: (int(v) if isinstance(v, (int, float)) or str(v).isdigit() else v)
                             for k, v in (rows[0] if rows else {}).items()}
            result["mcl_ok"] = True
        except Exception as e:  # noqa: BLE001
            result["errors"].append(f"MCL update failed, so nothing was written (not the MCL, not the denied list): {e}")
            return result
    if plan["denied_payload"]:
        try:
            rows = db.write_file("publish_denied", [json.dumps(plan["denied_payload"])], denied_table=denied_table)
            result["denied"] = {k: (int(v) if isinstance(v, (int, float)) or str(v).isdigit() else v)
                                for k, v in (rows[0] if rows else {}).items()}
            result["denied_ok"] = True
        except Exception as e:  # noqa: BLE001
            result["errors"].append(f"Denied-list update failed: {e}")

    result["warnings"] += _counts_note(result, plan)
    try:
        written = {**plan, "items": [it for it in plan["items"]
                                     if (it["kind"] == "mcl" and result["mcl_ok"]) or (it["kind"] == "denied" and result["denied_ok"])]}
        result["verify"] = _verify(written, db, mcl_table, denied_table)
    except Exception as e:  # noqa: BLE001
        result["warnings"].append(f"Couldn't read the results back to verify them: {e}")
    return result


def log_entries(plan, result, tables):
    """One change-log row per write that succeeded."""
    out = []
    for it in plan["items"]:
        ok = (it["kind"] == "mcl" and result["mcl_ok"]) or (it["kind"] == "denied" and result["denied_ok"])
        if not ok or it["action"] not in ("insert", "merge", "deny"):
            continue
        out.append({
            "run_id": result["run_id"], "action": it["action"],
            "target_table": tables["denied"] if it["kind"] == "denied" else tables["mcl"],
            "partyname": it["after"]["partyname"], "phone_numbers": list(it["phones"] or []),
            "before_json": json.dumps(it["before"], default=str) if it["before"] else None,
            "after_json": json.dumps(it["after"], default=str),
            "reason": ("New-to-MCL review" + (f": {'; '.join(it['notes'])}" if it["notes"] else ""))[:1000],
        })
    return out


def write_remote_log(db, entries, log_table):
    if not entries:
        return
    db.write_file("log_create", log_table=log_table)
    db.write_file("log_insert", [json.dumps(entries)], log_table=log_table)


# ---------------------------------------------------------------- local log (data/publish_log.jsonl)

def append_local_log(path, plan, result):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    entry = {
        "run_id": result["run_id"], "at": result["at"], "mode": result["mode"],
        "counts": plan["counts"], "mcl": result.get("mcl"), "denied": result.get("denied"),
        "errors": result["errors"], "warnings": result["warnings"], "verify": result["verify"],
        "items": [{"row": it["row_id"] + 1, "name": it["name"], "action": it["action"], "target": it.get("target"),
                   "changes": it["changes"], "problems": it["problems"]} for it in plan["items"]],
    }
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, default=str) + "\n")


def read_local_log(path, limit=200):
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    continue
    return list(reversed(out))[:limit]
