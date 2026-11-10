"""memo_common resolves Candystore per the 8683 port contract."""

import unittest

import memo_common as c


class CandystoreBaseTest(unittest.TestCase):
    def test_default_is_the_contract(self):
        self.assertEqual(c.CANDYSTORE_DEFAULT_URL, "http://127.0.0.1:8683")
        self.assertEqual(c.candystore_base({}), "http://127.0.0.1:8683")

    def test_memo_override_wins(self):
        env = {"MEMO_CANDYSTORE_URL": "http://memo:1/", "CANDYSTORE_URL": "http://shared:2"}
        self.assertEqual(c.candystore_base(env), "http://memo:1")

    def test_platform_candystore_url_is_honored(self):
        self.assertEqual(c.candystore_base({"CANDYSTORE_URL": "http://127.0.0.1:3603/"}), "http://127.0.0.1:3603")

    def test_blank_values_fall_through(self):
        self.assertEqual(c.candystore_base({"MEMO_CANDYSTORE_URL": " ", "CANDYSTORE_URL": ""}), c.CANDYSTORE_DEFAULT_URL)


if __name__ == "__main__":
    unittest.main()
