import { describe, it, expect } from "vite-plus/test";
import { projectReadmeContent, injectSnippet } from "../src/templates.js";

describe("projectReadmeContent", () => {
  it("describes the file format and agent usage", () => {
    const md = projectReadmeContent(true);
    expect(md).toContain("File format");
    expect(md).toContain("engram context");
    expect(md).toContain("type: decision");
    expect(md).toContain("never invent an id");
  });
  it("reflects tracked vs gitignored", () => {
    expect(projectReadmeContent(true)).toContain("tracked in git");
    expect(projectReadmeContent(false)).toContain("gitignored");
  });
});

describe("injectSnippet", () => {
  it("tells agents how to use the CLI", () => {
    const s = injectSnippet();
    expect(s).toContain("engram context");
    expect(s).toContain("engram search");
    expect(s).toContain("engram add");
    expect(s).toContain("--scope personal");
  });
  it("warns agents never to hand-write files or guess ids", () => {
    const s = injectSnippet();
    expect(s).toContain("never guess an id");
    expect(s).toContain("globally-unique id");
    expect(s).toContain("safe from id collisions");
  });
});
