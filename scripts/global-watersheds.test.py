import unittest
from grit_routing import route_segments


def segment(i, start, end, main=1, width=30):
    return dict(global_id=i, upstream_node_id=start, downstream_node_id=end, is_mainstem=main, width_adjusted=width)


class RoutingTests(unittest.TestCase):
    def test_tributaries_join_and_secondary_delta_outlet_stays_separate(self):
        rows = [segment(1, 1, 3), segment(2, 2, 3), segment(3, 3, 4), segment(4, 3, 5, 0)]
        route = route_segments(rows)
        self.assertEqual(route[1], (4, 3))
        self.assertEqual(route[2], (4, 3))
        self.assertEqual(route[4], (5, 4))

    def test_canal_does_not_merge_two_primary_basins(self):
        rows = [segment(1, 1, 2), segment(2, 2, 3), segment(3, 2, 5, 0), segment(4, 4, 5), segment(5, 5, 6)]
        route = route_segments(rows)
        self.assertEqual(route[1], (3, 2))
        self.assertEqual(route[4], (6, 5))
        self.assertEqual(route[3], (6, 5))

    def test_cycle_fails_instead_of_inventing_an_outlet(self):
        with self.assertRaises(ValueError):
            route_segments([segment(1, 1, 2), segment(2, 2, 1)])

    def test_equal_width_tie_is_stable_under_input_order(self):
        rows = [segment(1, 1, 2), segment(2, 2, 3), segment(3, 2, 4)]
        self.assertEqual(route_segments(rows), route_segments(rows[::-1]))


if __name__ == '__main__':
    unittest.main()
