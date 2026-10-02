#!/usr/bin/env python3
"""send_via_portcloud 的异步两段式投递测试。

全程使用 mock 与假时钟，不发起任何真实网络请求。
兼容 Python 3.9（不使用 unittest.TestCase.enterContext）。
"""

import json
import os
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

import monitor  # noqa: E402


class _NonJson:
    """标记响应体无法解析为 JSON。"""


NON_JSON = _NonJson()


class FakeResponse:
    def __init__(self, status_code, payload=None, text=None):
        self.status_code = status_code
        self._payload = payload
        if text is not None:
            self.text = text
        elif payload is None or payload is NON_JSON:
            self.text = ""
        else:
            self.text = json.dumps(payload)

    def json(self):
        if self._payload is NON_JSON:
            raise ValueError("Expecting value: line 1 column 1 (char 0)")
        return self._payload


class FakeClock:
    """假单调时钟：sleep 推进时间并记录每次 sleep 的时长。"""

    def __init__(self, start=1000.0):
        self.t = start
        self.sleeps = []

    def monotonic(self):
        return self.t

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.t += seconds


class PortcloudTestBase(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self._start_patch(monitor.time, "monotonic", self.clock.monotonic)
        self._start_patch(monitor.time, "sleep", self.clock.sleep)
        self.post = self._start_patch(monitor.requests, "post", Mock())
        self.get = self._start_patch(monitor.requests, "get", Mock())

    def _start_patch(self, target, name, value):
        patcher = patch.object(target, name, value)
        patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def _accepted(self, log_id=7):
        self.post.return_value = FakeResponse(201, {"log_id": log_id, "status": "queued"})

    def _status(self, log_id=7, status="success", failure_reason=None):
        return FakeResponse(
            200,
            {
                "log_id": log_id,
                "status": status,
                "failure_reason": failure_reason,
                "message_id": None,
                "smtp_response": None,
                "duration_ms": 1,
                "created_at": "2026-10-02T00:00:00+08:00",
            },
        )

    def send(self, subject="s", html="<p>h</p>", text="t"):
        return monitor.send_via_portcloud(subject, html, text)


class TestSuccess(PortcloudTestBase):
    def test_success_first_poll_after_one_second(self):
        self._accepted(log_id=7)
        self.get.return_value = self._status(7, "success")

        result = self.send()

        self.assertIsNone(result)
        self.assertEqual(self.post.call_count, 1)
        self.assertEqual(self.get.call_count, 1)
        # 首次轮询在受理 1 秒之后，且只 sleep 一次。
        self.assertEqual(self.clock.sleeps, [1.0])
        url = self.get.call_args.args[0]
        self.assertTrue(url.endswith("/api/v1/send/7"), url)
        headers = self.get.call_args.kwargs["headers"]
        self.assertEqual(headers["Authorization"], f"Bearer {monitor.PC_KEY}")

    def test_pending_then_success_at_one_second_intervals(self):
        self._accepted(log_id=11)
        self.get.side_effect = [
            self._status(11, "queued"),
            self._status(11, "sending"),
            self._status(11, "success"),
        ]

        self.send()

        self.assertEqual(self.get.call_count, 3)
        self.assertEqual(self.clock.sleeps, [1.0, 1.0, 1.0])

    def test_post_is_sent_exactly_once(self):
        self._accepted(log_id=3)
        self.get.side_effect = [self._status(3, "queued"), self._status(3, "success")]

        self.send()

        self.assertEqual(self.post.call_count, 1)
        payload = self.post.call_args.kwargs["json"]
        self.assertEqual(payload["to"], monitor.PC_TO)
        self.assertIn("html", payload)
        self.assertIn("text", payload)


class TestTerminalFailures(PortcloudTestBase):
    def test_failed_raises_with_reason(self):
        self._accepted(log_id=42)
        self.get.return_value = self._status(42, "failed", "smtp_timeout")

        with self.assertRaises(RuntimeError) as ctx:
            self.send()

        msg = str(ctx.exception)
        self.assertIn("failed", msg)
        self.assertIn("smtp_timeout", msg)
        self.assertIn("42", msg)
        # 明确的投递失败不是「结果未知」。
        self.assertNotIsInstance(ctx.exception, monitor.PortcloudUnconfirmed)
        self.assertEqual(self.post.call_count, 1)
        self.assertEqual(self.get.call_count, 1)

    def test_rejected_raises_with_reason(self):
        self._accepted(log_id=43)
        self.get.return_value = self._status(43, "rejected", "recipient_not_verified")

        with self.assertRaises(RuntimeError) as ctx:
            self.send()

        msg = str(ctx.exception)
        self.assertIn("rejected", msg)
        self.assertIn("recipient_not_verified", msg)
        self.assertNotIsInstance(ctx.exception, monitor.PortcloudUnconfirmed)

    def test_failed_without_reason_still_raises(self):
        self._accepted(log_id=44)
        self.get.return_value = self._status(44, "failed", None)

        with self.assertRaises(RuntimeError):
            self.send()


class TestBudgetAndTimeout(PortcloudTestBase):
    def test_timeout_exhausts_budget_and_is_unconfirmed(self):
        self._accepted(log_id=5)
        self.get.return_value = self._status(5, "queued")
        self._start_patch(monitor, "PC_TIMEOUT", 3)

        with self.assertRaises(monitor.PortcloudUnconfirmed) as ctx:
            self.send()

        msg = str(ctx.exception)
        self.assertIn("5", msg)
        self.assertEqual(self.get.call_count, 2)
        self.assertEqual(self.clock.sleeps, [1.0, 1.0, 1.0])

    def test_request_timeout_capped_by_remaining_budget(self):
        self._accepted(log_id=6)
        self.get.return_value = self._status(6, "success")
        self._start_patch(monitor, "PC_TIMEOUT", 3)

        self.send()

        # POST 保留 60 秒超时；首次 GET 在 sleep(1) 之后剩余预算 2 秒。
        self.assertEqual(self.post.call_args.kwargs["timeout"], 60)
        self.assertEqual(self.get.call_args.kwargs["timeout"], 2)

    def test_request_timeout_capped_at_sixty(self):
        self._accepted(log_id=60)
        self.get.return_value = self._status(60, "success")
        self._start_patch(monitor, "PC_TIMEOUT", 300)

        self.send()

        # 预算充足时，单次请求超时封顶 60 秒。
        self.assertEqual(self.post.call_args.kwargs["timeout"], 60)
        self.assertEqual(self.get.call_args.kwargs["timeout"], 60)

    def test_no_retry_after_success_within_budget(self):
        self._accepted(log_id=8)
        self.get.return_value = self._status(8, "success")
        self._start_patch(monitor, "PC_TIMEOUT", 60)

        self.send()

        self.assertEqual(self.get.call_count, 1)


class TestTransientRetry(PortcloudTestBase):
    def test_connection_error_then_success(self):
        self._accepted(log_id=9)
        self.get.side_effect = [
            monitor.requests.ConnectionError("boom"),
            self._status(9, "success"),
        ]

        self.send()

        self.assertEqual(self.get.call_count, 2)
        # 外层首次等待 1s + 内层重试等待 1s。
        self.assertEqual(self.clock.sleeps, [1.0, 1.0])

    def test_timeout_exception_then_success(self):
        self._accepted(log_id=10)
        self.get.side_effect = [
            monitor.requests.Timeout("slow"),
            self._status(10, "success"),
        ]

        self.send()

        self.assertEqual(self.get.call_count, 2)

    def test_http_429_then_success(self):
        self._accepted(log_id=12)
        self.get.side_effect = [FakeResponse(429, text="rate limited"), self._status(12, "success")]

        self.send()

        self.assertEqual(self.get.call_count, 2)

    def test_http_500_then_success(self):
        self._accepted(log_id=13)
        self.get.side_effect = [FakeResponse(500, text="oops"), self._status(13, "success")]

        self.send()

        self.assertEqual(self.get.call_count, 2)


class TestPermanentFailuresUnconfirmed(PortcloudTestBase):
    def test_persistent_connection_error_unconfirmed(self):
        self._accepted(log_id=20)
        self.get.side_effect = monitor.requests.ConnectionError("down")
        self._start_patch(monitor, "PC_TIMEOUT", 3)

        with self.assertRaises(monitor.PortcloudUnconfirmed) as ctx:
            self.send()

        self.assertIn("20", str(ctx.exception))
        self.assertGreaterEqual(self.get.call_count, 2)

    def test_http_404_unconfirmed_no_retry(self):
        self._accepted(log_id=21)
        self.get.return_value = FakeResponse(404, {"detail": "Not Found"})

        with self.assertRaises(monitor.PortcloudUnconfirmed):
            self.send()

        self.assertEqual(self.get.call_count, 1)

    def test_http_401_unconfirmed(self):
        self._accepted(log_id=22)
        self.get.return_value = FakeResponse(401, {"detail": "bad key"})

        with self.assertRaises(monitor.PortcloudUnconfirmed):
            self.send()

        self.assertEqual(self.get.call_count, 1)


class TestMalformedResponses(PortcloudTestBase):
    def test_post_non_json_unconfirmed(self):
        self.post.return_value = FakeResponse(201, NON_JSON, text="<html>oops</html>")

        with self.assertRaises(monitor.PortcloudUnconfirmed) as ctx:
            self.send()

        self.assertIn("投递结果未知", str(ctx.exception))
        self.assertEqual(self.post.call_count, 1)
        self.assertEqual(self.get.call_count, 0)

    def test_post_missing_log_id_unconfirmed(self):
        self.post.return_value = FakeResponse(201, {"status": "queued"})

        with self.assertRaises(monitor.PortcloudUnconfirmed):
            self.send()

        self.assertEqual(self.get.call_count, 0)

    def test_post_bool_log_id_rejected(self):
        # bool 是 int 的子类，True 不能被当作 log_id=1。
        self.post.return_value = FakeResponse(201, {"log_id": True, "status": "queued"})

        with self.assertRaises(monitor.PortcloudUnconfirmed):
            self.send()

        self.assertEqual(self.get.call_count, 0)

    def test_post_zero_log_id_rejected(self):
        self.post.return_value = FakeResponse(201, {"log_id": 0, "status": "queued"})

        with self.assertRaises(monitor.PortcloudUnconfirmed):
            self.send()

    def test_get_non_json_unconfirmed(self):
        self._accepted(log_id=30)
        self.get.return_value = FakeResponse(200, NON_JSON, text="not json")

        with self.assertRaises(monitor.PortcloudUnconfirmed):
            self.send()

    def test_get_wrong_log_id_unconfirmed(self):
        self._accepted(log_id=31)
        self.get.return_value = self._status(999, "success")

        with self.assertRaises(monitor.PortcloudUnconfirmed):
            self.send()

    def test_get_bool_or_float_log_id_unconfirmed(self):
        for value in (True, 1.0):
            with self.subTest(log_id=value):
                self._accepted(log_id=1)
                self.get.return_value = self._status(value, "success")
                with self.assertRaises(monitor.PortcloudUnconfirmed):
                    self.send()

    def test_get_unknown_status_unconfirmed(self):
        self._accepted(log_id=32)
        self.get.return_value = self._status(32, "banana")

        with self.assertRaises(monitor.PortcloudUnconfirmed):
            self.send()


class TestNoPostRetry(PortcloudTestBase):
    def test_post_http_error_not_retried(self):
        self.post.return_value = FakeResponse(500, {"error": {"code": "X"}}, text="err")

        with self.assertRaises(RuntimeError) as ctx:
            self.send()

        self.assertNotIsInstance(ctx.exception, monitor.PortcloudUnconfirmed)
        self.assertEqual(self.post.call_count, 1)
        self.assertEqual(self.get.call_count, 0)

    def test_post_403_not_retried(self):
        self.post.return_value = FakeResponse(403, {"error": {"code": "STAR_REQUIRED"}}, text="no")

        with self.assertRaises(RuntimeError):
            self.send()

        self.assertEqual(self.post.call_count, 1)
        self.assertEqual(self.get.call_count, 0)

    def test_post_connection_error_unconfirmed_no_retry(self):
        self.post.side_effect = monitor.requests.ConnectionError("refused")

        with self.assertRaises(monitor.PortcloudUnconfirmed):
            self.send()

        self.assertEqual(self.post.call_count, 1)
        self.assertEqual(self.get.call_count, 0)


class TestConfig(unittest.TestCase):
    def test_default_when_blank(self):
        self.assertEqual(monitor.parse_pc_timeout(None), 60)
        self.assertEqual(monitor.parse_pc_timeout(""), 60)
        self.assertEqual(monitor.parse_pc_timeout("   "), 60)

    def test_positive_integer(self):
        self.assertEqual(monitor.parse_pc_timeout("1"), 1)
        self.assertEqual(monitor.parse_pc_timeout("120"), 120)
        self.assertEqual(monitor.parse_pc_timeout(" 45 "), 45)

    def test_invalid_values_raise(self):
        for bad in ("0", "-1", "-60", "abc", "1.5", "60s"):
            with self.assertRaises(ValueError, msg=bad):
                monitor.parse_pc_timeout(bad)

    def test_module_default_is_positive_int(self):
        self.assertIsInstance(monitor.PC_TIMEOUT, int)
        self.assertGreater(monitor.PC_TIMEOUT, 0)


class TestRunStateGuard(unittest.TestCase):
    """状态只在投递成功后保存；结果未知时不落状态。"""

    def _run_with(self, send_side_effect):
        item = {
            "postUrl": "u1",
            "tags": [],
            "prices": [],
            "zh": "",
            "title": "t",
            "author": "",
            "date": "",
        }
        save = patch.object(monitor, "save_state").start()
        self.addCleanup(patch.stopall)
        patches = [
            patch.object(monitor, "LLM_API_KEY", "k"),
            patch.object(monitor, "load_state", return_value={"sent": []}),
            patch.object(monitor, "fetch_feed", return_value={"items": []}),
            patch.object(monitor, "parse_posts", return_value=[{"postUrl": "u1"}]),
            patch.object(monitor, "classify", return_value=[{"i": 0}]),
            patch.object(monitor, "merge", return_value=[item]),
            patch.object(monitor, "build_digest", return_value=("s", "d")),
            patch.object(monitor, "build_text", return_value="t"),
            patch.object(monitor, "send_mail", side_effect=send_side_effect),
        ]
        for p in patches:
            p.start()
        return save

    def test_state_not_saved_on_unconfirmed(self):
        save = self._run_with(monitor.PortcloudUnconfirmed("投递结果未知"))

        with self.assertRaises(monitor.PortcloudUnconfirmed):
            monitor.run()

        save.assert_not_called()

    def test_state_not_saved_on_delivery_failure(self):
        save = self._run_with(RuntimeError("Portcloud 投递failed"))

        with self.assertRaises(RuntimeError):
            monitor.run()

        save.assert_not_called()

    def test_state_saved_on_success(self):
        save = self._run_with(None)

        self.assertEqual(monitor.run(), 0)

        save.assert_called_once()


if __name__ == "__main__":
    unittest.main()
