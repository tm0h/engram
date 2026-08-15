import { describe, it, expect } from "vite-plus/test";
import { projectReadmeContent, injectSnippet } from "../src/templates.js";

describe("projectReadmeContent", () => {
  it("describes the file format and agent usage", () => {
    const md = projectReadmeContent(true);
    expect(md).toContain("File format");
    expect(md).toContain("engram context");
    expect(md).toContain("type: decision");
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
});
