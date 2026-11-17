import { it, expect } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectConfigPath, projectEngramsDir } from "@engram/core";
import {
  autoContextOp,
  contextualRecallOp,
  runOpAtDirectory,
  type ContextualRecallOptions,
} from "../src/shared/index.js";

it("binds real read-only recall and actual bootstrap identities to the supplied workspace", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engram-recall-"));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  const home = path.join(tmp, "home");
  const a = path.join(tmp, "a");
  const b = path.join(tmp, "b");
  const seed = (root: string, title: string) => {
    fs.mkdirSync(projectEngramsDir(root), { recursive: true });
    fs.writeFileSync(projectConfigPath(root), JSON.stringify({ version: 1, tracked: true }));
    fs.writeFileSync(
      path.join(projectEngramsDir(root), `0001-${title.replaceAll(" ", "-")}.md`),
      `---\nid: "0001"\ntitle: ${title}\ntype: fact\ntags: []\nscope: project\npinned: true\ncreated: 2020-01-01T00:00:00.000Z\nupdated: 2020-01-01T00:00:00.000Z\n---\n${title}\n`,
    );
  };
  try {
    process.env.HOME = home;
    fs.mkdirSync(path.join(home, ".engram"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".engram/config.json"),
      JSON.stringify({ version: 1, autoContext: "on", autoContextScope: "project" }),
    );
    seed(a, "sqlite migration");
    seed(b, "oauth rotation");
    const contents = () =>
      fs
        .readdirSync(tmp, { recursive: true })
        .filter((p) => fs.statSync(path.join(tmp, p as string)).isFile())
        .map((p) => [p, fs.readFileSync(path.join(tmp, p as string), "utf8")]);
    const before = contents();
    const boot = await runOpAtDirectory(a, autoContextOp());
    const bootstrap = boot.details.bootstrap as ContextualRecallOptions["bootstrap"];
    expect(bootstrap).toMatchObject({
      projectRoot: a,
      selected: [{ id: "0001", scope: "project" }],
    });
    const opts: ContextualRecallOptions = { prompt: "sqlite migration", intent: "task" };
    expect((await runOpAtDirectory(a, contextualRecallOp(opts))).text).toContain(
      "sqlite migration",
    );
    expect((await runOpAtDirectory(a, contextualRecallOp({ ...opts, bootstrap }))).text).toBe("");
    expect((await runOpAtDirectory(b, contextualRecallOp(opts))).text).toBe("");
    expect(
      (
        await runOpAtDirectory(
          b,
          contextualRecallOp({ ...opts, prompt: "oauth rotation", bootstrap }),
        )
      ).text,
    ).toContain("oauth rotation");
    expect(contents()).toEqual(before);
    expect(process.cwd()).toBe(originalCwd);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
