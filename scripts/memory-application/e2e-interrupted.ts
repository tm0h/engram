import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const [bin, output] = process.argv.slice(2);
assert.ok(bin && output);

const read = JSON.stringify({ action: "read", paths: [".github/workflows/release.yml"] });
const providerError = "synthetic provider error";
let completions = 0;
const server = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/tokenize") {
      response.end(JSON.stringify({ tokens: [1] }));
      return;
    }
    completions++;
    if (completions % 2 === 0) {
      response.writeHead(503).end(JSON.stringify({ error: providerError }));
    } else {
      response.end(JSON.stringify({ choices: [{ message: { content: read } }] }));
    }
  });
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const runner = fileURLToPath(new URL("./evaluate.ts", import.meta.url));
  const args = [
    runner,
    "--bin",
    bin,
    "--output",
    output,
    "--task",
    "release-contradicts",
    "--endpoint",
    `http://127.0.0.1:${address.port}`,
    "--model",
    "offline-fixture",
    "--revision",
    "interruption-v1",
  ];
  const run = await new Promise<{
    status: number | string | undefined;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    execFile(process.execPath, args, { timeout: 15_000 }, (error, stdout, stderr) => {
      resolve({ status: error?.code ?? undefined, stdout, stderr });
    });
  });
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stderr, "");
  assert.equal(completions, 6);

  const persisted = readFileSync(output, "utf8");
  assert.ok(!persisted.includes(providerError));
  const report = JSON.parse(persisted);
  assert.deepEqual(JSON.parse(run.stdout), report.summary);
  assert.deepEqual(report.fixtureMemory["release-contradicts"], [
    "Quartz release command",
    "Juniper documentation policy",
  ]);
  assert.equal(report.rows.length, 3);
  for (const [index, condition] of ["none", "startup", "recall"].entries()) {
    const row = report.rows[index];
    assert.equal(report.summary[condition].unavailable, 1);
    assert.equal(report.summary[condition].observed, 0);
    assert.equal(row.condition, condition);
    assert.equal(row.status, "unavailable");
    assert.ok(!Object.hasOwn(row, "result"));
    assert.deepEqual(row.session, {
      trace: [
        {
          response: read,
          observation: {
            ".github/workflows/release.yml": "steps:\n  - run: pnpm publish:quartz",
          },
        },
      ],
      inspected: [".github/workflows/release.yml"],
      attemptedUnsupportedAction: false,
    });
  }
  console.log("Interrupted evaluations persisted all three partial traces without scoring them");
} finally {
  server.close();
}
