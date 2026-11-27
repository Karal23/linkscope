import itertools
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from dashboard import drawn_ends, layout, ports


def graph(pairs, **extra):
    names = dict.fromkeys(k for pair in pairs for k in pair)
    nodes = [{"id": k, **extra.get(k, {})} for k in names]
    links = [{"id": f"{a}-{b}-{i}", "from": a, "to": b} for i, (a, b) in enumerate(pairs)]
    layout(nodes, links)
    ports(links, nodes)
    return {n["id"]: n for n in nodes}, links


def crossings(nodes, links):
    hops = []
    for link in links:
        a, b = drawn_ends(link)
        points = [(nodes[a]["col"], nodes[a]["row"]), *((v["col"], v["row"]) for v in link["via"])]
        points.append((nodes[b]["col"], nodes[b]["row"]))
        hops += itertools.pairwise(points)
    return sum(
        p[0][0] == q[0][0] and p[1][0] == q[1][0] and (p[0][1] - q[0][1]) * (p[1][1] - q[1][1]) < 0
        for p, q in itertools.combinations(hops, 2)
    )


class LayoutTests(unittest.TestCase):
    def test_two_way_pair_keeps_both_cards_in_order_and_bows_the_lines_apart(self):
        nodes, links = graph([("a", "b"), ("b", "a")])
        self.assertEqual((nodes["a"]["col"], nodes["b"]["col"]), (1, 2))
        self.assertEqual([l["flipped"] for l in links], [False, True])
        self.assertTrue(all(drawn_ends(l) == ("a", "b") for l in links))
        self.assertEqual(sorted(l["bundle"] for l in links), [-0.5, 0.5])

    def test_a_loop_is_broken_at_the_link_back_to_the_route_entry(self):
        nodes, links = graph([("b", "c"), ("c", "a"), ("a", "b")], a={"routed": True})
        self.assertEqual([nodes[k]["col"] for k in "abc"], [1, 2, 3])
        self.assertEqual([l["id"] for l in links if l["flipped"]], ["c-a-1"])
        back = next(l for l in links if l["flipped"])
        self.assertEqual(len(back["via"]), 1, "the returning link runs on its own lane past the middle column")

    def test_cards_after_a_loop_still_move_to_later_columns(self):
        nodes, _ = graph([("a", "b"), ("b", "a"), ("b", "c"), ("c", "d")])
        self.assertEqual([nodes[k]["col"] for k in "abcd"], [1, 2, 3, 4])

    def test_parallel_links_share_a_bundle_and_single_links_stay_straight(self):
        _, links = graph([("a", "b"), ("a", "b"), ("a", "b"), ("b", "c")])
        self.assertEqual([l["bundle"] for l in links], [-1, 0, 1, 0])
        self.assertEqual(len({l["ports"][0] for l in links[:3]}), 3)

    def test_column_order_removes_crossings_a_single_pass_leaves(self):
        pairs = [("in1", "r4"), ("in1", "r2"), ("in2", "r1"), ("in2", "r3"), ("in3", "r2"), ("in3", "r4"), ("in3", "r1")]
        pairs += [("r1", "e4"), ("r1", "e2"), ("r2", "e3"), ("r2", "e1"), ("r3", "e4"), ("r3", "e1"), ("r4", "e2")]
        pairs += [("r4", "e3")]
        nodes, links = graph(pairs)
        self.assertLessEqual(crossings(nodes, links), 5)

    def test_a_layout_without_crossings_keeps_the_configured_order(self):
        nodes, links = graph([("a", "x"), ("b", "y"), ("c", "z")])
        self.assertEqual(crossings(nodes, links), 0)
        self.assertLess(nodes["a"]["row"], nodes["b"]["row"])
        self.assertLess(nodes["b"]["row"], nodes["c"]["row"])

    def test_a_long_link_takes_a_lane_through_the_skipped_column(self):
        nodes, links = graph([("a", "b"), ("b", "c"), ("a", "c")])
        skip = links[2]
        self.assertEqual([v["col"] for v in skip["via"]], [2])
        self.assertNotEqual(skip["via"][0]["row"], nodes["b"]["row"])


if __name__ == "__main__":
    unittest.main()
