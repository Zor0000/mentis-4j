import assert from "node:assert/strict";
import { test } from "node:test";
import { Database } from "../dist/db.js";

function fakeDatabase(values) {
  let statement;
  let parameters;
  const database = {
    read(work, config) {
      assert.equal(config.timeout, 5000);
      return work({
        run(query, queryParameters) {
          statement = query;
          parameters = queryParameters;
          return {
            subscribe(observer) {
              observer.onKeys(["value"]);
              for (const value of values) {
                observer.onNext({ values: () => [value] });
              }
              observer.onCompleted();
            },
          };
        },
      });
    },
  };
  return {
    database,
    statement: () => statement,
    parameters: () => parameters,
  };
}

test("bounds recall rows and serialized output size", async () => {
  const byRows = fakeDatabase(Array.from({ length: 101 }, (_, index) => index));
  const rows = await Database.prototype.readCypher.call(
    byRows.database,
    "UNWIND range(1, 101) AS value RETURN value",
    { taskId: "task-1" },
  );
  assert.equal(byRows.parameters().__mentisRowLimit, 101);
  assert.match(byRows.statement(), /CALL \{/);
  assert.match(byRows.statement(), /LIMIT \$__mentisRowLimit$/);
  assert.equal(rows.rows.length, 100);
  assert.equal(rows.truncated, true);
  assert.equal(rows.truncationReason, "row_limit");

  const byBytes = fakeDatabase(["x".repeat(511_950)]);
  const large = await Database.prototype.readCypher.call(
    byBytes.database,
    "RETURN $value AS value",
    {},
  );
  assert.deepEqual(large.rows, []);
  assert.equal(large.truncated, true);
  assert.equal(large.truncationReason, "response_size_limit");
  assert.ok(Buffer.byteLength(JSON.stringify(large)) <= 512_000);
});
