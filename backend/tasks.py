"""Probe assignments and measurement series for a specific topology revision."""

import json
import os


def route_tests_enabled():
    return os.environ.get("LINKSCOPE_ROUTE_TESTS") == "1"


def fixed_ingresses():
    if os.environ.get("LINKSCOPE_FIXED_INGRESS") != "zhejiang":
        return {}
    return {
        f"zj-{code}": dict(
            region="浙江", provider=carrier, mode="ICMP", host=f"zj-{code}-v4.ip.zstaticcdn.com"
        )
        for code, carrier in (("ct", "电信"), ("cu", "联通"))
    }


def series_id(key, version):
    return f"{key}@{version}"


def mesh(cfg):
    graph = {group: {item["id"]: item for item in rows} for group, rows in cfg.items()}
    refs = {key: [] for key in graph["links"]}
    for route in cfg["routes"]:
        for link_id in route["tail"]:
            refs[link_id].append(route["id"])
    graph["members"] = {key: sorted(ids) for key, ids in refs.items()}
    return graph


def path_nodes(route, graph):
    return [route["entry"], *(graph["links"][key]["to"] for key in route["tail"])]


def route_segments(route, graph):
    segments = []
    for key in route["tail"]:
        link = graph["links"][key]
        label = " → ".join(graph["nodes"][link[side]]["name"] for side in ("from", "to"))
        segments.append(dict(id=key, version=min(route["version"], link["version"]), mode=link["mode"], label=label))
    return segments


def archived_segments(db, archived, graph):
    if "segments" in archived:
        return archived["segments"]
    # Older archives retained the route's node names and link IDs, but not the link versions.
    path = archived.get("path", [])
    names = archived["label"].split(" → ")
    if len(names) != len(path):
        names = path
    segments = []
    for key, left, right in zip(archived.get("links", []), names, names[1:]):
        link = graph["links"].get(key)
        if not link or link["version"] > archived["version"]:
            row = db.execute(
                """SELECT body FROM task_history WHERE kind='link' AND id=? AND version<=?
                   ORDER BY version DESC LIMIT 1""", (key, archived["version"]),
            ).fetchone()
            link = json.loads(row[0]) if row else {}
        segments.append(dict(id=key, version=link.get("version"), mode=link.get("mode"), label=f"{left} → {right}"))
    return segments


def history_segments(db, cfg, key, version):
    graph = mesh(cfg)
    route = graph["routes"].get(key)
    if route and (version is None or version == route["version"]):
        return route["entry"], route_segments(route, graph)
    row = db.execute(
        "SELECT body FROM task_history WHERE kind='route' AND id=? AND version=?", (key, version),
    ).fetchone()
    if row:
        archived = json.loads(row[0])
        return archived["path"][0], archived_segments(db, archived, graph)
    return None, []


def path_key(route, graph):
    # Parallel links can reach the same node through different networks.
    endpoints = [
        (key, graph["nodes"][key].get("address"), graph["nodes"][key].get("port"))
        for key in path_nodes(route, graph)
    ]
    return json.dumps([route["tail"], endpoints], separators=(",", ":"))


def definition(kind, item, graph):
    nodes = graph["nodes"]
    if kind == "link":
        observer = item.get("observer")
        target = item["from"] if observer == item["to"] else item["to"]
        members = graph["members"][item["id"]]
        return dict(
            version=item["version"],
            observer=observer,
            target=target,
            mode=item["mode"],
            enabled=bool(item["mode"] and (members or item.get("standalone"))),
            routeIds=members,
            source=nodes[observer]["source"] if observer else None,
            host=nodes[target].get("address"),
            port=nodes[target].get("port") if item["mode"] == "TCP" else None,
            path=[observer, target] if observer else [item["from"], item["to"]],
        )
    path = path_nodes(item, graph)
    return dict(
        version=item["version"],
        observer="client",
        target=path[-1],
        path=path,
        links=item["tail"],
        source=item["testSource"],
        enabled=item["test"],
        proxy=item.get("testProxy"),
        testMode=item.get("testMode", "http204"),
        url=item.get("testUrl"),
    )


def archive(db, kind, item, graph, closed):
    key, version = item["id"], item["version"]
    old = definition(kind, item, graph)
    old["label"] = " → ".join(graph["nodes"][n]["name"] for n in old["path"])
    if kind == "route":
        old["segments"] = route_segments(item, graph)
        old["entryName"] = graph["nodes"][item["entry"]]["name"]
    db.execute("INSERT INTO task_history VALUES(?,?,?,?,?)", (kind, key, version, closed, json.dumps(old)))
    stored = series_id(key, version)
    db.execute("DELETE FROM latest WHERE kind=? AND id=?", (kind, stored))
    if kind == "route":
        db.execute("DELETE FROM latest WHERE kind='summary' AND id=?", (stored,))
    db.execute("DELETE FROM events WHERE kind=? AND id=?", (kind, key))


def migrate(db, cfg, revision, now):
    """Keep pre-version samples as v0, without promoting them to fresh measurements."""
    graph = mesh(cfg)
    for link in cfg["links"]:
        link.setdefault("standalone", not graph["members"][link["id"]])
    access = db.execute("SELECT body FROM latest WHERE kind='access' AND id='client'").fetchone()
    access = json.loads(access[0]) if access else {}
    observed = {rid for session in access.get("sessions", []) for rid in session["traffic"]}
    for r in cfg["routes"]:
        row = db.execute("SELECT body FROM latest WHERE kind='route' AND id=?", (r["id"],)).fetchone()
        r.setdefault(
            "testSource",
            json.loads(row[0]).get("source", "system")
            if row
            else access.get("source", "system")
            if r["id"] in observed
            else "system",
        )
    for group, kind in (("links", "link"), ("routes", "route")):
        for item in cfg[group]:
            if "version" in item:
                continue
            key = item["id"]
            item["version"] = 0
            previous = db.execute(
                "SELECT 1 FROM samples WHERE kind=? AND id=? LIMIT 1", (kind, key)
            ).fetchone()
            if previous:
                archive(db, kind, item, graph, now)
            for k in [kind, "summary"] if kind == "route" else [kind]:
                db.execute("UPDATE samples SET id=? WHERE kind=? AND id=?", (series_id(key, 0), k, key))
                db.execute("DELETE FROM latest WHERE kind=? AND id=?", (k, key))
            item.update(version=revision, allowLocalChecks=True)
    for route in cfg["routes"]:
        if route.get("testProxy"):
            db.execute(
                "INSERT OR REPLACE INTO route_bindings VALUES(?,?,?)",
                (route["id"], path_key(route, graph), route["testProxy"]),
            )
    # Legacy session records had no route version.
    db.execute("DELETE FROM latest WHERE kind='access'")
    db.execute("UPDATE config SET body=? WHERE id=1", (json.dumps(cfg),))


def revise(db, previous, cfg, revision, now, confirmed):
    old, new = mesh(previous), mesh(cfg)
    changed_links = set()
    for group, kind in (("links", "link"), ("routes", "route")):
        for key in old[group].keys() | new[group].keys():
            before, after = old[group].get(key), new[group].get(key)
            if after:
                after["version"] = before["version"] if before else revision
                after["allowLocalChecks"] = before.get("allowLocalChecks", False) if before else False
            if kind == "route" and after:
                binding_key = path_key(after, new)
                moved = before is not None and path_key(before, old) != binding_key
                if (
                    moved
                    and key not in confirmed
                    and (not after.get("testProxy") or after.get("testProxy") == before.get("testProxy"))
                ):
                    binding = db.execute(
                        "SELECT proxy FROM route_bindings WHERE id=? AND path=?", (key, binding_key)
                    ).fetchone()
                    after["testProxy"] = binding[0] if binding else None
                if after.get("testProxy"):
                    # Rebinding a listener retires its previous path on this route.
                    db.execute(
                        "DELETE FROM route_bindings WHERE id=? AND proxy=? AND path<>?",
                        (key, after["testProxy"], binding_key),
                    )
                    db.execute(
                        "INSERT OR REPLACE INTO route_bindings VALUES(?,?,?)",
                        (key, binding_key, after["testProxy"]),
                    )
                else:
                    db.execute("DELETE FROM route_bindings WHERE id=? AND path=?", (key, binding_key))
            if before and after:
                a = definition(kind, before, old)
                b = definition(kind, after, new)
                if kind == "link":
                    # The drawing direction affects the meaning of forward/reverse rates.
                    a.pop("routeIds")
                    b.pop("routeIds")
                    changed = a != b or before["from"] != after["from"]
                else:
                    changed = a != b or moved or bool(changed_links.intersection(after["tail"]))
                if not changed:
                    continue
            if before:
                archive(db, kind, before, old, now)
            if after:
                after.update(version=revision, allowLocalChecks=False)
            if kind == "link":
                changed_links.add(key)
            elif not after:
                db.execute("DELETE FROM route_bindings WHERE id=?", (key,))


def assignments(cfg, reporter, source):
    graph = mesh(cfg)
    result = {"links": {}, "routes": {}}
    if (
        source == "system"
        and graph["nodes"].get(reporter, {}).get("kind") == "agent"
        and any(r["entry"] == reporter for r in cfg["routes"])
    ):
        result["references"] = fixed_ingresses()
    for group, kind in (("links", "link"), ("routes", "route")):
        if kind == "route" and not route_tests_enabled():
            continue
        for item in cfg[group]:
            task = definition(kind, item, graph)
            if task["observer"] != reporter or task["source"] != source:
                continue
            if not task["enabled"]:
                continue
            result[group][item["id"]] = {**task, "allowLocalChecks": item.get("allowLocalChecks", False)}
    return result


def archive_end(db, kind, key, version, closed, until=None):
    sql = "SELECT max(at) FROM samples WHERE kind=? AND id=?"
    args = (kind, series_id(key, version))
    if until is not None:
        sql += " AND at<=?"
        args += (until,)
    return max(closed, db.execute(sql, args).fetchone()[0] or 0)


def versions(db, kind, key, cfg):
    graph = mesh(cfg)
    item = graph["links" if kind == "link" else "routes"].get(key)
    rows = []
    if item:
        task = definition(kind, item, graph)
        rows.append(
            dict(
                version=task["version"],
                closed=None,
                entry=task["path"][0] if kind == "route" else None,
                mode=task.get("mode"),
                testMode=task.get("testMode", "http204") if kind == "route" else None,
                label=" → ".join(graph["nodes"][i]["name"] for i in task["path"]),
            )
        )
    for row in db.execute(
        "SELECT version,closed,body FROM task_history WHERE kind=? AND id=? ORDER BY version DESC",
        (kind, key),
    ):
        archived = json.loads(row["body"])
        rows.append(
            dict(
                version=row["version"],
                closed=row["closed"],
                end=archive_end(db, kind, key, row["version"], row["closed"]),
                entry=archived["path"][0] if kind == "route" and archived.get("path") else None,
                mode=archived.get("mode"),
                testMode=archived.get("testMode", "http204") if kind == "route" else None,
                label=archived["label"],
            )
        )
        if kind == "route":
            r = rows[-1]
            r["segments"] = archived_segments(db, archived, graph)
            r["entryName"] = archived.get("entryName", r["label"].split(" → ")[0])
            # A retired entry can disappear from the live map. Offer the carriers recorded by this version.
            sample = db.execute(
                """SELECT json_extract(body,'$.estimates') FROM samples
                   WHERE kind='summary' AND id=? ORDER BY at DESC LIMIT 1""",
                (series_id(key, r["version"]),),
            ).fetchone()
            estimates = json.loads(sample[0]) if sample and sample[0] else {}
            r["references"] = [
                dict(id=ref, region="浙江", provider=provider)
                for code, provider in (("ct", "电信"), ("cu", "联通"))
                if (ref := f"{r['entry']}/zj-{code}-icmp") in estimates
            ]
    return rows
