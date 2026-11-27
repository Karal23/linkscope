import hmac
import json
import math
import re
from bisect import bisect_right
from collections import defaultdict
from itertools import chain, pairwise
from statistics import median

import tasks
from store import DAY, FRESH, GIB, config, now_ms, peer_id, write_sample

LATENCY_KINDS = {"link", "route", "reference"}
LATENCY_FRESH = 45_000
# A round counts as elevated when it clears both margins over the series' own 24-hour median.
ELEVATED_RATIO = 1.5
ELEVATED_MARGIN = 5
# The baseline reads one 30-second slice of every five minutes. The slice test runs on the
# primary-key index, so only those rows are fetched. Twelve slices cover the first hour.
BASELINE_EVERY = 300_000
BASELINE_SLICE = 30_000
BASELINE_MIN = 12
BASELINE_TTL = 600_000
# Each frame refreshes at most this many expired baselines and keeps the older value for the rest.
BASELINE_REFRESH = 3
# Detail bars per history span. None draws one bar per measured round.
BAR_COUNTS = {5: None, 60: 60, 1440: 48}
_baselines = {}
# Only a timed-out attempt counts as a TCP timeout. A successful legacy attempt also proves a response.
TCP_TIMEOUT = """coalesce(json_extract(body,'$.tcpTimeout'),
    CASE WHEN json_extract(body,'$.latency') IS NOT NULL AND json_extract(body,'$.failureRate')=0 THEN 0 END)"""
ICMP_LOSS = "json_extract(body,'$.packetLoss')"


def complete_sum(values):
    values = list(values)
    return sum(values) if values and all(v is not None for v in values) else None


def elevated_at(baseline):
    return None if baseline is None else max(baseline * ELEVATED_RATIO, baseline + ELEVATED_MARGIN)


def database_file(db):
    return db.execute("PRAGMA database_list").fetchone()[2]


def latency_baseline(db, kind, key, end, path="$.latency", file=None, budget=None):
    """Median latency over the day before `end`. Every frame asks, so results are kept for ten minutes."""
    slot = (file or database_file(db), kind, key, path)
    cached = _baselines.get(slot)
    if cached and 0 <= end - cached[0] < BASELINE_TTL:
        return cached[1]
    if budget is not None:
        if budget[0] <= 0:
            return cached[1] if cached else None
        budget[0] -= 1
    rows = db.execute(
        """SELECT at, json_extract(body,?) AS v FROM samples
           WHERE kind=? AND id=? AND at>? AND at<=? AND at % ? < ? AND v IS NOT NULL""",
        (path, kind, key, end - DAY, end, BASELINE_EVERY, BASELINE_SLICE),
    ).fetchall()
    slices = {r["at"] // BASELINE_EVERY for r in rows}
    value = median(r["v"] for r in rows) if len(slices) >= BASELINE_MIN else None
    if len(_baselines) > 4000:
        _baselines.clear()
    _baselines[slot] = (end, value)
    return value


def loop_closers(nodes, links):
    """Return the links that close a loop, such as the second link of a two-way pair.

    The search starts from nodes nothing points at and from route entries, so the natural
    flow keeps its direction and the returning link is the one drawn against it."""
    outgoing, pointed = defaultdict(list), set()
    for link in links:
        outgoing[link["from"]].append(link)
        pointed.add(link["to"])
    keys = [n["id"] for n in nodes]
    roots = [k for k in keys if k not in pointed] + [n["id"] for n in nodes if n.get("routed")] + keys
    state, closers = {}, set()
    for root in roots:
        if root in state:
            continue
        state[root] = "open"
        stack = [(root, iter(outgoing[root]))]
        while stack:
            key, pending = stack[-1]
            link = next(pending, None)
            if link is None:
                state[key] = "done"
                stack.pop()
            elif state.get(link["to"]) == "open":
                closers.add(link["id"])
            elif link["to"] not in state:
                state[link["to"]] = "open"
                stack.append((link["to"], iter(outgoing[link["to"]])))
    return closers


def drawn_ends(link):
    """Left and right end of a link on the map; a flipped link runs right to left."""
    return (link["to"], link["from"]) if link.get("flipped") else (link["from"], link["to"])


def order_columns(columns, levels, incoming, outgoing, sweeps=8):
    """Order every column to cut line crossings.

    The first pass sorts each column by the average position of its parents. Sweeps in both
    directions and swaps of neighbours follow, and an order is kept only when it crosses less."""
    position = {}

    def place(col):
        for i, k in enumerate(columns[col]):
            position[k] = (i + 0.5) / len(columns[col])

    def centre(k, near):
        return sum(position[n] for n in near[k]) / len(near[k]) if near[k] else position[k]

    def crossings():
        total = 0
        for col in levels[:-1]:
            edges = [(position[a], position[b]) for a in columns[col] for b in outgoing[a]]
            for i, (a1, b1) in enumerate(edges):
                total += sum((a1 - a2) * (b1 - b2) < 0 for a2, b2 in edges[i + 1 :])
        return total

    def pair_cost(upper, lower):
        return sum(
            position[a] > position[b] for near in (incoming, outgoing) for a in near[upper] for b in near[lower]
        )

    def swap_neighbours():
        for _ in range(50):
            changed = False
            for col in levels:
                slots = columns[col]
                for i in range(len(slots) - 1):
                    if pair_cost(slots[i + 1], slots[i]) < pair_cost(slots[i], slots[i + 1]):
                        slots[i], slots[i + 1] = slots[i + 1], slots[i]
                        place(col)
                        changed = True
            if not changed:
                return

    for col in levels:
        if col != levels[0]:
            columns[col].sort(
                key=lambda k: sum(position.get(x, 0.5) for x in incoming[k]) / max(1, len(incoming[k]))
            )
        place(col)
    best, cost = {col: list(columns[col]) for col in levels}, crossings()

    def keep():
        nonlocal best, cost
        found = crossings()
        if found < cost:
            best, cost = {col: list(columns[col]) for col in levels}, found

    swap_neighbours()
    keep()
    for _ in range(sweeps):
        if not cost:
            break
        for col in reversed(levels[:-1]):
            columns[col].sort(key=lambda k: centre(k, outgoing))
            place(col)
        swap_neighbours()
        keep()
        for col in levels[1:]:
            columns[col].sort(key=lambda k: centre(k, incoming))
            place(col)
        swap_neighbours()
        keep()
    for col in levels:
        columns[col][:] = best[col]


def layout(nodes, links, lanes=None):
    """Place cards in columns and reserve a lane for each (visitor, entry) connection."""
    by_id = {n["id"]: n for n in nodes}
    closers = loop_closers(nodes, links)
    incoming = defaultdict(int)
    outgoing = defaultdict(list)
    for link in links:
        link["flipped"] = link["id"] in closers
        source, target = drawn_ends(link)
        outgoing[source].append(target)
        incoming[target] += 1
    linked = set(incoming) | set(outgoing)
    queue = [n["id"] for n in nodes if not incoming[n["id"]]]
    depths = {key: 1 for key in queue}
    for key in queue:
        for target in outgoing[key]:
            depths[target] = max(depths.get(target, 1), depths[key] + 1)
            incoming[target] -= 1
            if not incoming[target]:
                queue.append(target)
    columns = defaultdict(list)
    for n in nodes:
        key = n["id"]
        n["col"] = depths.get(key, 1)
        if key in linked or n.get("routed"):
            columns[n["col"]].append(key)
    if not columns:
        return by_id

    # A skipped column needs a free lane just like a card, so a long link never cuts through it.
    incoming_slots, outgoing_slots = defaultdict(list), defaultdict(list)
    waypoints = {}
    for link in links:
        source, target = drawn_ends(link)
        path = [source]
        for col in range(by_id[source]["col"] + 1, by_id[target]["col"]):
            slot = (link["id"], col)
            columns[col].append(slot)
            path.append(slot)
        path.append(target)
        waypoints[link["id"]] = path[1:-1]
        for a, b in zip(path, path[1:]):
            outgoing_slots[a].append(b)
            incoming_slots[b].append(a)
    # A visitor joins in front of the first column, so an entry further right needs the same lanes.
    first, lane_paths = min(columns), {}
    for connection in lanes or ():
        _, entry = connection
        path = [(connection, col) for col in range(first, by_id[entry]["col"])]
        for slot in path:
            columns[slot[1]].append(slot)
        for a, b in zip(path, [*path[1:], entry]):
            outgoing_slots[a].append(b)
            incoming_slots[b].append(a)
        lane_paths[connection] = path

    levels = sorted(columns)
    order_columns(columns, levels, incoming_slots, outgoing_slots)
    rows = {k: (i + 0.5) / len(columns[col]) for col in levels for i, k in enumerate(columns[col])}
    anchor = max(levels, key=lambda c: len(columns[c]))
    spacing = 1 / len(columns[anchor])
    for col in [*range(anchor - 1, levels[0] - 1, -1), *range(anchor + 1, levels[-1] + 1)]:
        slots = columns[col]
        adjacent = outgoing_slots if col < anchor else incoming_slots
        for k in slots:
            if adjacent[k]:
                rows[k] = sum(rows[n] for n in adjacent[k]) / len(adjacent[k])
        # Keep adjacent cards separated while aligning parents to the centre of their branches.
        for i, k in enumerate(slots):
            rows[k] = max(rows[k], rows[slots[i - 1]] + spacing if i else spacing / 2)
        for i in reversed(range(len(slots))):
            k = slots[i]
            rows[k] = min(rows[k], rows[slots[i + 1]] - spacing if i + 1 < len(slots) else 1 - spacing / 2)
    for key, n in by_id.items():
        if key in rows:
            n["row"] = rows[key]
    for link in links:
        link["via"] = [{"col": k[1], "row": rows[k]} for k in waypoints[link["id"]]]
    for connection, path in lane_paths.items():
        lanes[connection] = [{"col": k[1], "row": rows[k]} for k in path]
    return by_id


def ports(links, nodes):
    """Spread the ends of links that share a card, and number links that share both cards.

    Parallel links between the same two cards get a bundle offset so the map can bow them apart."""
    positions = {n["id"]: n.get("row", 0.5) for n in nodes}
    outgoing, incoming, pairs = defaultdict(list), defaultdict(list), defaultdict(list)
    for link in links:
        source, target = drawn_ends(link)
        outgoing[source].append(link)
        incoming[target].append(link)
        if not link.get("via"):
            pairs[source, target].append(link)
    for group in outgoing.values():
        group.sort(key=lambda l: l["via"][0]["row"] if l.get("via") else positions[drawn_ends(l)[1]])
    for group in incoming.values():
        group.sort(key=lambda l: l["via"][-1]["row"] if l.get("via") else positions[drawn_ends(l)[0]])
    for link in links:
        source, target = drawn_ends(link)
        a, b = outgoing[source], incoming[target]
        link["ports"] = [(a.index(link) - (len(a) - 1) / 2) * 10, (b.index(link) - (len(b) - 1) / 2) * 10]
        link["bundle"] = 0
    for group in pairs.values():
        for i, link in enumerate(group):
            link["bundle"] = i - (len(group) - 1) / 2


def viewer_peer(identifier, secret):
    return "peer-" + hmac.digest(secret, identifier.encode("ascii"), "sha256").hex()[:32]


def resolve_viewer_peer(db, key, secret):
    """Resolve a visible link without accepting a raw address from the viewer."""
    match = re.fullmatch(r"(peer-[a-f0-9]{32})-([a-z][a-z0-9_-]{0,39})", key)
    if match:
        for reporter, body in db.execute(
            "SELECT id,body FROM latest WHERE kind='access' AND at>?", (now_ms() - DAY,)
        ):
            for s in json.loads(body)["sessions"]:
                raw = peer_id(s["ip"], reporter)
                if s["entry"] == match[2] and viewer_peer(raw, secret) == match[1]:
                    return raw + "-" + s["entry"]
    return None


def reported_access(sessions, routes, by_id, viewer_key, lanes, timeout_rates):
    source_nodes, access_links = {}, []
    for (raw, entry), (at, source, s, traffic) in sessions.items():
        ip = s["ip"]
        source_id = viewer_peer(raw, viewer_key) if viewer_key else raw
        displayed_ip = "地址已隐藏" if viewer_key else ip
        src = source_nodes.setdefault(
            raw,
            dict(
                id=source_id,
                name=s["place"],
                place=s["place"],
                provider=s["provider"],
                sourceIp=displayed_ip,
                source=source,
                last=at,
                entries=[],
                role="接入来源",
                col=0,
                icon="globe",
                tone=by_id[entry]["tone"],
                state="connected",
            ),
        )
        src["entries"].append(entry)
        reading = {k: s.get(k) for k in ("latency", "packetLoss", "failureRate")}
        if s["mode"] == "TCP":
            reading["tcpTimeout"] = s.get("tcpTimeout")
            reading["tcpLoss"] = timeout_rates.get(("peer", raw + "-" + entry))
        for key in ("forward", "reverse"):
            reading[key] = complete_sum((v or {}).get(key) for v in traffic.values())
        direct = any(not routes[k]["tail"] for k in traffic)
        access_links.append(
            {
                "id": src["id"] + "-" + entry,
                "from": src["id"],
                "to": entry,
                "observer": src["id"],
                "sourceIp": displayed_ip,
                "source": source,
                "mode": s["mode"],
                "direct": direct,
                "traffic": traffic,
                "tone": by_id[entry]["tone"],
                "last": at,
                "reading": reading,
                "service": s["provider"],
                "name": "直连落地" if direct else "接入连接",
                "via": lanes[(raw, entry)],
                # Popped once the state is known, so a viewer never receives the raw address.
                "_series": ("peer", raw + "-" + entry),
            }
        )
    sources = sorted(
        source_nodes.values(),
        key=lambda n: sum(by_id[e].get("row", 0.5) for e in n["entries"]) / len(n["entries"]),
    )
    for i, n in enumerate(sources):
        n["row"] = (
            by_id[n["entries"][0]].get("row", 0.5)
            if len(sources) == 1
            else (0.19 + 0.62 * i if len(sources) == 2 else 0.06 + 0.88 * i / (len(sources) - 1))
        )
    return sources, access_links


def reference_loss_transition(window):
    """A full loss or three lossy rounds in five opens an alert. Three clean rounds close it."""
    if window[-1] == 100 or sum(loss > 0 for loss in window) >= 3:
        return True
    if window[-3:] == [0, 0, 0]:
        return False
    return None


def reference_loss_alerts(db, key, rounds):
    """Replay the same alert at any zoom, including one already active at the window boundary."""
    first = rounds[0][0]
    previous = first
    prefix = []
    for at, loss in db.execute(
        f"SELECT at,{ICMP_LOSS} FROM samples WHERE kind='reference' AND id=? AND at<? ORDER BY at DESC",
        (key, first),
    ):
        if previous - at > LATENCY_FRESH or loss is None:
            break
        prefix.append((at, loss))
        previous = at
        # Either decision also establishes a known state when these rounds are replayed forwards.
        if reference_loss_transition([v for _, v in prefix[-5:]]) is not None:
            break

    active = False
    window = []
    previous = None
    for at, loss in chain(reversed(prefix), rounds):
        if loss is None or (previous is not None and at - previous > LATENCY_FRESH):
            active = False
            window = []
        previous = at
        level = None
        if loss is not None:
            window = [*window[-4:], loss]
            transition = reference_loss_transition(window)
            if transition is not None:
                active = transition
            level = "warning" if active else "normal"
            if window[-2:] == [100, 100]:
                level = "critical"
        if at >= first:
            yield level


def fixed_access(db, carriers, nodes, routes, latest, timeout_rates, now):
    sources, access_links = [], []
    entries = [n for n in nodes if n["routed"]]
    for carrier, definition in carriers.items():
        source_id = "peer-fixed-" + carrier
        source_name = definition["region"] + definition["provider"]
        sources.append(
            dict(
                id=source_id,
                name=source_name,
                place=definition["region"],
                provider=definition["provider"],
                countryCode="CN",
                kind="reference",
                role="固定入口",
                icon="globe",
                tone="rose",
                state="reference",
                routed=True,
            )
        )
        for n in entries:
            entry = n["id"]
            series = f"{entry}/{carrier}-icmp"
            stamp, sample = latest.get(("reference", series), (None, {}))
            fresh = stamp is not None and now - stamp <= LATENCY_FRESH
            ref = dict(
                id=series,
                region=definition["region"],
                provider=definition["provider"],
                mode="ICMP",
                at=stamp,
                latency=sample.get("latency") if fresh else None,
                packetLoss=sample.get("packetLoss") if fresh else None,
                loss=timeout_rates.get(("reference", series)) if fresh else None,
            )
            ref["lossAlert"] = (
                next(reference_loss_alerts(db, series, [(stamp, ref["packetLoss"])]))
                if ref["packetLoss"] is not None else None
            )
            n.setdefault("references", []).append(ref)
            access_links.append(
                {
                    "id": source_id + "-" + entry,
                    "from": source_id,
                    "to": entry,
                    "observer": entry,
                    "referenceId": series,
                    "mode": "ICMP",
                    "tone": "rose",
                    "service": "固定入口反测",
                    "name": n["name"] + " → " + source_name,
                    "last": stamp,
                    "pending": stamp is None,
                    "reading": ref,
                    "traffic": {},
                    "candidates": [r["id"] for r in routes.values() if r["entry"] == entry],
                }
            )
    return sources, access_links


def snapshot(db, now=None, viewer_key=None):
    now = now if now is not None else now_ms()
    revision, cfg = config(db)
    route_tests = tasks.route_tests_enabled()
    latest = {
        (r["kind"], r["id"]): (r["at"], json.loads(r["body"]))
        for r in db.execute(
            "SELECT * FROM latest WHERE kind IN ('host','link','access','reference') OR (kind='route' AND ?)",
            (route_tests,),
        )
    }
    carriers = tasks.fixed_ingresses()
    timeout_rates = {
        (r["kind"], r["id"]): r["rate"]
        for r in db.execute(
            f"""SELECT kind,id,avg(CASE WHEN kind='reference' THEN {ICMP_LOSS} ELSE {TCP_TIMEOUT} END) AS rate
                FROM samples WHERE (kind IN ('link','reference') OR (kind='peer' AND ?))
                AND at>? AND at<=? GROUP BY kind,id""",
            (not carriers, now - 60_000, now + 2000),
        )
    }
    meters = {r["id"]: r["used"] for r in db.execute("SELECT id,used FROM meter")}
    routes = {r["id"]: r for r in cfg["routes"]}
    nodes, links = cfg["nodes"], cfg["links"]
    for n in nodes:
        key = n["id"]
        n["routed"] = any(r["entry"] == key for r in routes.values())
        at, host = latest.get(("host", key), (None, {}))
        n["last"] = at
        used = meters.get(key)
        n["usedGiB"] = None if used is None else used / GIB
        n["remaining"] = None if used is None or n["quotaGiB"] is None else max(0, n["quotaGiB"] - used / GIB)
        if n["kind"] == "agent":
            n["state"] = "waiting" if at is None else "online" if now - at <= FRESH else "offline"
            n["host"] = host
            n["reading"] = host if n["state"] == "online" else {}
        else:
            n["state"] = n["kind"]
    sessions = {}
    for (kind, reporter), (at, access) in sorted(latest.items(), key=lambda pair: pair[1][0]):
        if kind != "access" or now - at > FRESH:
            continue
        for s in access["sessions"]:
            entry = s["entry"]
            traffic = {
                k: v
                for k, v in s["traffic"].items()
                if k in routes
                and routes[k]["entry"] == entry
                and access.get("routeVersions", {}).get(k) == routes[k]["version"]
                and routes[k]["testSource"] == access["source"]
            }
            if not traffic:
                continue
            pair = (peer_id(s["ip"], reporter), entry)
            previous = sessions.get(pair)
            if previous:
                traffic = {**previous[3], **traffic}
            sessions[pair] = (at, access["source"], s, traffic)
    lanes = dict.fromkeys(sessions)
    by_id = {n["id"]: n for n in nodes} if carriers else layout(nodes, links, lanes)
    for l in links:
        at, s = latest.get(("link", tasks.series_id(l["id"], l["version"])), (None, {}))
        target = by_id[l["from"] if l["observer"] == l["to"] else l["to"]]
        observer = by_id.get(l["observer"])
        l["pending"] = bool(
            l["mode"]
            and at is None
            and (l.get("standalone") or any(l["id"] in r["tail"] for r in routes.values()))
        )
        l["needsAddress"] = bool(
            l["mode"]
            and observer
            and observer["source"] == "system"
            and (not target.get("address") or (l["mode"] == "TCP" and not target.get("port")))
        )
        l.update(last=at, reading=s if at is not None and now - at <= LATENCY_FRESH else {})
        if l["mode"] == "TCP" and l["reading"]:
            l["reading"]["tcpLoss"] = timeout_rates.get(("link", tasks.series_id(l["id"], l["version"])))
    if carriers:
        sources, access_links = fixed_access(db, carriers, nodes, routes, latest, timeout_rates, now)
    else:
        sources, access_links = reported_access(sessions, routes, by_id, viewer_key, lanes, timeout_rates)
    nodes = sources + nodes
    links = access_links + links
    if carriers:
        by_id = layout(nodes, links)
    ports(links, nodes)
    file, budget = database_file(db), [BASELINE_REFRESH]
    for l in links:
        reading = l["reading"]
        l["rates"] = any(reading.get(k) is not None for k in ("forward", "reverse"))
        latency, failures = reading.get("latency"), reading.get("failureRate")
        loss = reading.get("tcpLoss") if l["mode"] == "TCP" else reading.get("packetLoss")
        series = l.pop("_series", None)
        if l.get("referenceId"):
            series = ("reference", l["referenceId"])
        elif "version" in l:
            series = ("link", tasks.series_id(l["id"], l["version"]))
        l["baseline"] = (
            latency_baseline(db, *series, now, file=file, budget=budget)
            if series and latency is not None
            else None
        )
        l["elevated"] = l["baseline"] is not None and latency >= elevated_at(l["baseline"])
        l["measured"] = any(v is not None for v in (latency, loss, failures))
        if l.get("referenceId"):
            fault = reading["lossAlert"] in ("warning", "critical")
        else:
            fault = latency is None or (loss or 0) > 0 or (failures or 0) > 0
        l["state"] = (
            "degraded"
            if l["measured"] and (fault or l["elevated"])
            else "normal"
            if l["measured"]
            else "pending"
            if l.get("pending")
            else "unmeasured"
        )
    hosts = [n for n in nodes if n.get("kind") == "agent"]
    online = [n for n in hosts if n["state"] == "online"]
    delays = [l["reading"]["latency"] for l in links if l["reading"].get("latency") is not None]
    measured = [l for l in links if l["measured"]]
    summaries = {
        "all": dict(
            online=len(online),
            total=len(hosts),
            delay=median(delays) if delays else None,
            upload=complete_sum(n["reading"].get("up") for n in online),
            download=complete_sum(n["reading"].get("down") for n in online),
            faults=sum(l["state"] == "degraded" for l in measured) if measured else None,
        )
    }
    attempts = defaultdict(list)
    if route_tests:
        for r in db.execute(
            "SELECT id,body FROM samples WHERE kind='route' AND at>? AND at<=?", (now - 300_000, now + 2000)
        ):
            attempts[r["id"]].append(json.loads(r["body"])["status"] == "ok")
    link_by_id = {l["id"]: l for l in links}
    for rid, r in routes.items():
        r["test"] = r["test"] and route_tests
        prefixes = [l for l in access_links if rid in l["traffic"] or rid in l.get("candidates", [])]
        r["paths"] = [[l["id"], *r["tail"]] for l in prefixes] or ([r["tail"]] if r["tail"] else [])
        r["links"] = list(dict.fromkeys(k for path in r["paths"] for k in path))
        sub = [
            link_by_id[k]
            for k in r["links"]
            if link_by_id[k]["measured"] and not link_by_id[k].get("referenceId")
        ]
        stored = tasks.series_id(rid, r["version"])
        stamp, attempt = latest.get(("route", stored), (None, {}))
        fresh = stamp is not None and now - stamp <= LATENCY_FRESH
        successes = attempts[stored]
        leg_delays = [link_by_id[i]["reading"].get("latency") for i in r["tail"]]
        summaries[rid] = dict(
            version=r["version"],
            delay=attempt.get("latency") if fresh else None,
            status=attempt.get("status") if fresh else "pending" if r["test"] and stamp is None else None,
            source=attempt.get("source") if fresh else None,
            success=(100 * sum(successes) / len(successes)) if successes else None,
            segmentSum=complete_sum(leg_delays),
            estimates={
                p["id"]: complete_sum([p["latency"], *leg_delays])
                for p in by_id[r["entry"]].get("references", [])
            },
            upload=complete_sum(
                (traffic[rid] or {}).get("forward")
                for _, _, _, traffic in sessions.values()
                if rid in traffic
            ),
            faults=sum(l["state"] == "degraded" for l in sub) if sub else None,
            measured=len(sub),
            segments=sum(not link_by_id[i].get("referenceId") for i in r["links"]),
            tcpSum=complete_sum(
                link_by_id[i]["reading"].get("latency") if link_by_id[i]["mode"] == "TCP" else None
                for i in r["tail"]
            ),
        )
    events = []
    for e in db.execute("SELECT * FROM events WHERE at>? ORDER BY at DESC LIMIT 100", (now - 3_600_000,)):
        key = e["id"]
        if e["kind"] == "link" and key in link_by_id:
            link = link_by_id[key]
            title = by_id[link["from"]]["name"] + " → " + by_id[link["to"]]["name"]
            kind = "link"
        elif e["kind"] == "host" and key in by_id:
            title = by_id[key]["name"]
            kind = "node"
        else:
            continue
        events.append(
            dict(
                type=kind,
                id=key,
                at=e["at"],
                title=title,
                text=e["text"],
                tone=e["tone"],
                icon="alert" if e["tone"] == "amber" else "check" if e["tone"] == "mint" else "offline",
            )
        )
    sample_times = [
        stamp for (kind, key), (stamp, data) in latest.items() if kind in ("access", "host", "link", "route")
    ]
    for r in routes.values():
        r["testReady"] = bool(r["test"] and r.get("testProxy") and r.get("testUrl"))
        if viewer_key:
            r.pop("testProxy", None)
            r.pop("testUrl", None)
    if viewer_key:
        for n in nodes:
            n.pop("address", None)
            n.pop("port", None)
    return dict(
        now=now,
        revision=revision,
        nodes=nodes,
        links=links,
        routes=list(routes.values()),
        summaries=summaries,
        events=events,
        lastReport=max(sample_times, default=None),
    )


def series_key(db, kind, key, version):
    if kind in ("link", "route") or (kind == "summary" and key != "all"):
        if version is None:
            group = "links" if kind == "link" else "routes"
            item = next((i for i in config(db)[1][group] if i["id"] == key), None)
            version = item["version"] if item else -1
        return tasks.series_id(key, version)
    return key


def latency_bar(t, rows, threshold, probed):
    """One detail bar with raw measurements and the link's quality during the interval."""
    n = len(rows)
    if not n:
        return {"t": round(t), "n": 0, "status": "gap"}
    values = sorted(r["latency"] for r in rows if r["latency"] is not None)
    losses = [r["loss"] for r in rows if r["loss"] is not None]
    loss = round(sum(losses) / len(losses), 2) if losses else None
    fails = n - len(values)
    high = sum(v >= threshold for v in values) if threshold is not None else 0
    lossy = sum((probed and r["latency"] is None) or (r["loss"] or 0) > 0 for r in rows)
    if "lossAlert" in rows[0].keys():
        alerts = {r["lossAlert"] for r in rows}
        if "critical" in alerts:
            status = "rose"
        elif "warning" in alerts or high:
            status = "amber"
        else:
            status = "mint" if values or losses else "gap"
    elif not values:
        status = "rose" if probed else "gap"
    elif n == 1:
        status = "rose" if (loss or 0) >= 5 else "amber" if lossy or high else "mint"
    elif lossy * 2 > n:
        status = "rose"
    elif lossy or high:
        status = "amber"
    else:
        status = "mint"
    return {
        "t": round(t),
        "n": n,
        "p50": median(values) if values else None,
        "max": values[-1] if values else None,
        "loss": loss,
        "fails": fails,
        "high": high,
        "status": status,
    }


def latency_rows(db, kind, key, start, end, path="$.latency"):
    regional = kind == "reference" and key.endswith(("/zj-ct-icmp", "/zj-cu-icmp"))
    loss = "NULL" if kind == "summary" else f"coalesce({ICMP_LOSS}, {TCP_TIMEOUT})"
    rows = db.execute(
        f"""SELECT at, json_extract(body,?) AS latency, {ICMP_LOSS if regional else loss} AS loss
            FROM samples WHERE kind=? AND id=? AND at>? AND at<=? ORDER BY at""",
        (path, kind, key, start, end),
    ).fetchall()
    if regional and rows:
        alerts = reference_loss_alerts(db, key, [(r["at"], r["loss"]) for r in rows])
        return [dict(r, lossAlert=level) for r, level in zip(rows, alerts)]
    return rows


def grouped_rounds(rows, start, step, count):
    groups = [[] for _ in range(count)]
    for r in rows:
        groups[min(count - 1, int((r["at"] - start) // step))].append(r)
    return groups


def apply_segment_status(db, route, version, carrier, start, end, count, points):
    entry, segments = tasks.history_segments(db, config(db)[1], route, version)
    if not entry or (carrier and not carrier.startswith(entry + "/")):
        return
    series = [("reference", carrier)] if carrier else []
    for segment in segments:
        key = None
        if segment["mode"] and segment["version"] is not None:
            key = tasks.series_id(segment["id"], segment["version"])
        series.append(("link", key))
    priority = {"mint": 0, "gap": 1, "amber": 2, "rose": 3}
    for kind, key in series:
        rows = latency_rows(db, kind, key, start if count else start - LATENCY_FRESH, end) if key else []
        threshold = elevated_at(latency_baseline(db, kind, key, end)) if rows else None
        if count:
            groups = grouped_rounds(rows, start, (end - start) / count, count)
        else:
            # The five-second sum uses the most recent still-fresh probe round at that instant.
            stamps = [r["at"] for r in rows]
            groups = []
            for p in points:
                i = bisect_right(stamps, p["t"]) - 1
                groups.append([rows[i]] if i >= 0 and p["t"] - stamps[i] <= LATENCY_FRESH else [])
        for p, group in zip(points, groups):
            if p["n"] == 0:
                continue
            status = latency_bar(p["t"], group, threshold, True)["status"]
            if status != "mint" and priority[status] > priority[p.get("segmentStatus", "mint")]:
                p["segmentStatus"] = status
            if priority[status] > priority[p["status"]]:
                p["status"] = status


def latency_bars(db, kind, key, end, minutes, version=None, carrier=None):
    """Latency history for the detail bars, with the series' own baseline and the window's spread."""
    stored = series_key(db, kind, key, version)
    path = "$.latency"
    if kind == "summary":
        path = f'$.estimates."{carrier}"' if carrier else "$.segmentSum"
    span = minutes * 60_000
    start = end - span
    rows = latency_rows(db, kind, stored, start, end, path)
    baseline = latency_baseline(db, kind, stored, end, path)
    threshold = elevated_at(baseline)
    probed = kind != "summary"
    count = BAR_COUNTS[minutes]
    if count:
        step = span / count
        groups = [
            (start + (i + 0.5) * step, group)
            for i, group in enumerate(grouped_rounds(rows, start, step, count))
        ]
    else:
        # One bar per round. Missed rounds become empty bars at the expected cadence.
        stamps = [r["at"] for r in rows]
        gaps = sorted(b - a for a, b in pairwise(stamps))
        step = gaps[len(gaps) // 2] if gaps else (30_000 if probed else 5_000)
        limit = LATENCY_FRESH if kind in LATENCY_KINDS else 7_500
        groups = []
        edges = [start, *stamps, end]
        for i, (a, b) in enumerate(pairwise(edges)):
            if b - a > limit:
                if 0 < i < len(stamps):
                    missing = max(1, round((b - a) / step) - 1)
                    marks = [a + (b - a) * (k + 1) / (missing + 1) for k in range(missing)]
                elif i == 0:
                    marks = [b - step * k for k in range(int((b - a) // step), 0, -1)]
                else:
                    marks = [a + step * (k + 1) for k in range(int((b - a) // step))]
                groups += [(t, []) for t in marks]
            if i < len(rows):
                groups.append((rows[i]["at"], [rows[i]]))
    values = sorted(r["latency"] for r in rows if r["latency"] is not None)
    losses = [r["loss"] for r in rows if r["loss"] is not None]
    points = [latency_bar(t, group, threshold, probed) for t, group in groups]
    if kind == "summary" and rows:
        apply_segment_status(db, key, version, carrier, start, end, count, points)
    return {
        "start": start,
        "end": end,
        "step": step,
        "baseline": baseline,
        "points": points,
        "stats": {
            "n": len(rows),
            "p50": median(values) if values else None,
            "p95": values[max(0, math.ceil(len(values) * 0.95) - 1)] if values else None,
            "max": values[-1] if values else None,
            "loss": round(sum(losses) / len(losses), 2) if losses else None,
        },
    }


def host_averages(db, key, end):
    count = BAR_COUNTS[1440]
    start, step = end - DAY, DAY // count
    metrics = ("cpu", "ram", "disk", "up", "down")
    averages = ", ".join(f"avg(json_extract(body,'$.{m}')) AS {m}" for m in metrics)
    points = [{"t": start + (i * step) + step // 2, "v": None} for i in range(count)]
    for r in db.execute(
        f"""SELECT min(?, (at-?)/?) AS slot, {averages} FROM samples
            WHERE kind='host' AND id=? AND at>? AND at<=? GROUP BY slot""",
        (count - 1, start, step, key, start, end),
    ):
        points[r["slot"]]["v"] = {m: r[m] for m in metrics}
    return {"start": start, "end": end, "step": step, "points": points}


def history(db, kind, key, end, span, count, version=None, raw=False, rate_metric=None):
    key = series_key(db, kind, key, version)
    start = end - span
    params = (kind, key, start, end)
    source = "FROM samples WHERE kind=? AND id=? AND at BETWEEN ? AND ?"
    if raw:
        query = f"SELECT at,body {source} ORDER BY at"
        points = [{"t": start, "v": None}]
        gap = LATENCY_FRESH if kind in LATENCY_KINDS else 7_500
    else:
        step = span / (count - 1)
        params = (start, step, *params)
        query = f"SELECT CAST((at-?)/?+0.5 AS INTEGER) AS slot, max(at) AS at, body {source} GROUP BY slot"
        points = [{"t": round(start + i * step), "v": None} for i in range(count)]
    if rate_metric:
        # At each displayed sample, look back into the original series, even across the view's left edge.
        outcome = {"tcpLoss": TCP_TIMEOUT, "loss": ICMP_LOSS}[rate_metric]
        query = f"""SELECT p.*, (SELECT avg({outcome}) FROM samples
                    WHERE kind=? AND id=? AND at>p.at-60000 AND at<=p.at) AS rate FROM ({query}) AS p ORDER BY p.at"""
        params = (kind, key, *params)
    for row in db.execute(query, params):
        at = row["at"]
        value = {rate_metric: row["rate"]} if rate_metric else json.loads(row["body"])
        if raw:
            previous = points[-1].get("at")
            if previous is not None and at - previous > gap:
                points.append({"t": (previous + at) // 2, "v": None})
            points.append({"t": at, "at": at, "v": value})
        else:
            points[row["slot"]].update(v=value, at=at)
    if raw:
        points.append({"t": end, "v": None})
    return points


def record_summaries(db, last_states):
    db.execute("BEGIN IMMEDIATE")
    snap = snapshot(db)
    now = snap["now"]
    for key, value in snap["summaries"].items():
        version = next((r["version"] for r in snap["routes"] if r["id"] == key), None)
        fields = ("upload", "download") if key == "all" else ("segmentSum", "upload", "estimates")
        if version is not None and tasks.route_tests_enabled():
            fields += ("delay",)
        write_sample(
            db,
            "summary",
            tasks.series_id(key, version) if version is not None else key,
            now,
            {k: value[k] for k in fields},
        )
    for n in snap["nodes"]:
        if n.get("kind") != "agent":
            continue
        key, state = n["id"], n["state"]
        if key in last_states and last_states[key] != state and state in ("online", "offline"):
            db.execute(
                "INSERT INTO events VALUES(?,?,?,?,?)",
                (
                    now,
                    "host",
                    key,
                    "心跳恢复" if state == "online" else "心跳中断",
                    "mint" if state == "online" else "neutral",
                ),
            )
        last_states[key] = state
    db.execute("DELETE FROM task_history WHERE closed<?", (now - DAY - 300_000,))
    db.execute(
        "DELETE FROM latest WHERE kind IN ('peer','access','ingress','reference') AND at<?", (now - DAY,)
    )
    db.execute(
        "DELETE FROM samples WHERE at<? AND (at<? OR kind IN ('peer','access'))",
        (now - DAY, now - DAY - 300_000),
    )
    db.execute("DELETE FROM web_sessions WHERE expires<=?", (now,))
    db.execute("DELETE FROM events WHERE at<?", (now - DAY - 300_000,))
