import { describe, it, expect } from "vite-plus/test";
import { Option } from "effect";
import { resolveScope, scopesToQuery, isValidScopeArg } from "../src/scope.js";

const some = Option.some("/repo");
const none = Option.none<string>();

describe("isValidScopeArg", () => {
  it("accepts the two real scopes", () => {
    expect(isValidScopeArg("personal")).toBe(true);
    expect(isValidScopeArg("project")).toBe(true);
  });
  it("rejects typos and junk instead of letting them fall back to a default", () => {
    expect(isValidScopeArg("persoanl")).toBe(false);
    expect(isValidScopeArg("all")).toBe(false);
    expect(isValidScopeArg("")).toBe(false);
  });
});

describe("resolveScope", () => {
  it("honors explicit personal/project", () => {
    expect(resolveScope("personal", some)).toBe("personal");
    expect(resolveScope("project", none)).toBe("project");
  });
  it("defaults to project when inside a project", () => {
    expect(resolveScope(undefined, some)).toBe("project");
  });
  it("defaults to personal when not in a project", () => {
    expect(resolveScope(undefined, none)).toBe("personal");
  });
});

describe("scopesToQuery", () => {
  it("expands 'all' to both scopes when in a project", () => {
    expect(scopesToQuery("all", some)).toEqual(["project", "personal"]);
  });
  it("expands 'all' to personal only when not in a project", () => {
    expect(scopesToQuery("all", none)).toEqual(["personal"]);
  });
  it("returns the resolved default for undefined", () => {
    expect(scopesToQuery(undefined, some)).toEqual(["project"]);
    expect(scopesToQuery(undefined, none)).toEqual(["personal"]);
  });
});
