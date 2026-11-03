import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCron, isFrequent, minutesOf } from "./cron";

// Every distinct shape in the live registry on 2026-11-03, plus the edges the review found.

test("minutesOf expands every minute-field form", () => {
  assert.equal(minutesOf("*")?.length, 60);
  assert.deepEqual(minutesOf("*/15"), [0, 15, 30, 45]);
  assert.deepEqual(minutesOf("1-59/20"), [1, 21, 41]);
  assert.deepEqual(minutesOf("7,22,37,52"), [7, 22, 37, 52]);
  assert.deepEqual(minutesOf("0-4"), [0, 1, 2, 3, 4]);
  assert.deepEqual(minutesOf("5/20"), [5, 25, 45]);
  assert.equal(minutesOf("L"), undefined);
  assert.equal(minutesOf("61"), undefined);
});

test("isFrequent flags anything firing more often than every 10 minutes", () => {
  for (const s of ["* * * * *", "*/5 * * * *", "1-59/2 * * * *", "1-59/5 * * * *", "*/2 9-17 * * 1-5"]) assert.equal(isFrequent(s), true, s);
  for (const s of ["*/10 * * * *", "*/15 * * * *", "7,22,37,52 * * * *", "0 * * * *", "30 4 * * *", "0 */2 * * *"]) assert.equal(isFrequent(s), false, s);
});

test("describeCron reads the live shapes", () => {
  const cases: Array<[string, string | undefined]> = [
    ["* * * * *", "every minute"],
    ["*/5 * * * *", "every 5 min"],
    ["1-59/2 * * * *", "every 2 min"],
    ["7,22,37,52 * * * *", "every 15 min"],
    ["0 * * * *", "hourly at :00"],
    ["0 */2 * * *", "every 2 h at :00"],
    ["37 4 * * *", "daily 04:37"],
    ["45 8 * * 1", "Mon 08:45"],
    ["15 3 * * 0", "Sun 03:15"],
    ["15 3 * * 7", "Sun 03:15"],
    ["30 8 * * 1-5", "weekdays 08:30"],
    ["0 9 1 * *", "monthly on the 1st 09:00"],
    ["0 0 1 1 *", undefined],
    ["0 9-17 * * *", undefined]
  ];
  for (const [expr, words] of cases) assert.equal(describeCron(expr), words, expr);
});
