import test from "node:test";
import assert from "node:assert/strict";
import { safePhoenixLink } from "../../admin-vben/apps/web-ele/src/api/phoenix-link.ts";

test("new admin accepts actual local HTTP Phoenix redirects, never cloud or executable URLs", () => {
  const path = "/redirects/traces/33333333333343338333333333333333";
  for (const origin of [
    "http://127.0.0.1:6006",
    "http://localhost:6006",
    "http://[::1]:6006",
    "http://phoenix:6006",
    "https://10.1.2.3:6006",
  ])
    assert.equal(safePhoenixLink(origin + path), origin + path);
  for (const value of [
    null,
    "javascript:alert(1)",
    "https://cloud.example" + path,
    "http://169.254.169.254" + path,
    "http://localhost:6006",
    "http://user:secret@localhost:6006" + path,
    "http://localhost:6006" + path + "?token=private",
  ])
    assert.equal(safePhoenixLink(value), null);
});
