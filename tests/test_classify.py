#!/usr/bin/env python3
"""classify() 的 LLM 响应解析测试。

覆盖模型在 JSON 数组后面追加内容、或用 markdown 代码块包裹的情况：
这些都会让贪婪正则 ``\\[[\\s\\S]*\\]`` 吃掉多余的 ``]`` 而报 "Extra data"。

不发起任何真实网络请求。
"""

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

import monitor  # noqa: E402

ARRAY = '[{"i":0,"tags":["vps"],"prices":[{"amount":3,"currency":"USD","period":"month"}],"zh":"x"}]'
PARSED = [{
    "i": 0,
    "tags": ["vps"],
    "prices": [{"amount": 3, "currency": "USD", "period": "month"}],
    "zh": "x",
}]


class TestFirstJsonArray(unittest.TestCase):
    def test_bare_array(self):
        self.assertEqual(monitor.first_json_array(ARRAY), PARSED)

    def test_extra_array_after(self):
        # 模型把结果输出了两遍：只取第一个数组。
        self.assertEqual(monitor.first_json_array(ARRAY + "\n" + ARRAY), PARSED)

    def test_trailing_note_with_bracket(self):
        # 数组后的说明里含 [] / ]，是本次线上故障的触发形态。
        self.assertEqual(monitor.first_json_array(ARRAY + "\n\n（价格档见上[]）"), PARSED)

    def test_trailing_empty_array(self):
        self.assertEqual(monitor.first_json_array(ARRAY + "\n[]"), PARSED)

    def test_markdown_fence(self):
        self.assertEqual(monitor.first_json_array("```json\n" + ARRAY + "\n```"), PARSED)

    def test_prose_before_array(self):
        self.assertEqual(monitor.first_json_array("好的，结果如下：\n" + ARRAY), PARSED)

    def test_bracket_inside_string(self):
        # 字符串里的 ] 与 " 不能参与括号配平。
        text = '[{"i":0,"tags":["a]b\\"c"],"prices":[],"zh":"x"}]'
        self.assertEqual(monitor.first_json_array(text)[0]["tags"], ['a]b"c'])

    def test_escaped_backslash_before_quote(self):
        text = '[{"i":0,"tags":["a\\\\"],"prices":[],"zh":"x"}]'
        self.assertEqual(monitor.first_json_array(text)[0]["tags"], ["a\\"])

    def test_leading_brace_object_ignored(self):
        # 数组前有个对象，不应影响取第一个数组。
        self.assertEqual(monitor.first_json_array('{"note":"x"}\n' + ARRAY), PARSED)

    def test_no_array_returns_none(self):
        self.assertIsNone(monitor.first_json_array("没有数组"))

    def test_unclosed_array_returns_none(self):
        self.assertIsNone(monitor.first_json_array('[{"i":0,'))

    def test_broken_json_raises(self):
        with self.assertRaises(RuntimeError):
            monitor.first_json_array('[{"i":0,]')


class TestClassify(unittest.TestCase):
    def test_uses_llm_output(self):
        posts = [{"title": "t", "body": "b"}]
        with patch.object(monitor, "llm_chat", return_value=ARRAY) as chat:
            self.assertEqual(monitor.classify(posts), PARSED)
        chat.assert_called_once()

    def test_trailing_junk_no_longer_breaks(self):
        # 线上故障形态：数组后多出一段带 ] 的内容。
        posts = [{"title": "t", "body": "b"}]
        with patch.object(monitor, "llm_chat", return_value=ARRAY + "\n\n（价格档见上[]）"):
            self.assertEqual(monitor.classify(posts), PARSED)

    def test_no_array_raises(self):
        posts = [{"title": "t", "body": "b"}]
        with patch.object(monitor, "llm_chat", return_value="抱歉，我不会"):
            with self.assertRaises(RuntimeError):
                monitor.classify(posts)


if __name__ == "__main__":
    unittest.main()
