import { describe, it, expect } from "vite-plus/test";
import { tokenizeQuery } from "../src/tokenize.js";

describe("case conventions", () => {
  it("splits camelCase into exact form plus subtokens", () => {
    expect(tokenizeQuery("parseEngramStore")).toEqual([
      "parseengramstore",
      "parse",
      "engram",
      "store",
    ]);
  });

  it("splits PascalCase", () => {
    expect(tokenizeQuery("EngramStore")).toEqual(["engramstore", "engram", "store"]);
  });

  it("splits acronym runs", () => {
    expect(tokenizeQuery("parseURLConfig")).toEqual(["parseurlconfig", "parse", "url", "config"]);
    expect(tokenizeQuery("XMLHttpRequest")).toEqual(["xmlhttprequest", "xml", "http", "request"]);
  });

  it("keeps a trailing acronym with its suffix whole", () => {
    expect(tokenizeQuery("URLs")).toEqual(["urls"]);
  });

  it("splits snake_case while keeping the joined form", () => {
    expect(tokenizeQuery("my_var_name")).toEqual(["my_var_name", "my", "var", "name"]);
  });

  it("splits kebab-case while keeping the joined form", () => {
    expect(tokenizeQuery("save-dev")).toEqual(["save-dev", "save", "dev"]);
    expect(tokenizeQuery("--save-dev")).toEqual(["save-dev", "save", "dev"]);
  });

  it("splits dotted identifiers", () => {
    expect(tokenizeQuery("parseEngramStore.add")).toEqual([
      "parseengramstore.add",
      "parse",
      "engram",
      "store",
      "add",
    ]);
  });

  it("attaches digits to the preceding word", () => {
    expect(tokenizeQuery("base64Encode")).toEqual(["base64encode", "base64", "encode"]);
    expect(tokenizeQuery("RFC822")).toEqual(["rfc822"]);
  });
});

describe("acronym plurals and digit shapes (ENG-21 remediation)", () => {
  it("splits acronym-plus-plural identifiers without one-letter fragments", () => {
    expect(tokenizeQuery("IDsTable")).toEqual(["idstable", "ids", "table"]);
    expect(tokenizeQuery("URLsTable")).toEqual(["urlstable", "urls", "table"]);
    expect(tokenizeQuery("parseIDsFromCache")).toEqual([
      "parseidsfromcache",
      "parse",
      "ids",
      "from",
      "cache",
    ]);
    expect(tokenizeQuery("IPv4Address")).toEqual(["ipv4address", "ipv4", "address"]);
    expect(tokenizeQuery("getURLsFromAPI")).toEqual([
      "geturlsfromapi",
      "get",
      "urls",
      "from",
      "api",
    ]);
    expect(tokenizeQuery("URLs2Table")).toEqual(["urls2table", "urls2", "table"]);
  });

  it("preserves the previously pinned acronym shapes", () => {
    expect(tokenizeQuery("URLs")).toEqual(["urls"]);
    expect(tokenizeQuery("XMLHttpRequest")).toEqual(["xmlhttprequest", "xml", "http", "request"]);
    expect(tokenizeQuery("parseURLConfig")).toEqual(["parseurlconfig", "parse", "url", "config"]);
    expect(tokenizeQuery("HTTPServer")).toEqual(["httpserver", "http", "server"]);
    expect(tokenizeQuery("getURLs")).toEqual(["geturls", "get", "urls"]);
    expect(tokenizeQuery("IDTable")).toEqual(["idtable", "id", "table"]);
    expect(tokenizeQuery("RFC822Handler")).toEqual(["rfc822handler", "rfc822", "handler"]);
    expect(tokenizeQuery("XMLHttpRequest2")).toEqual([
      "xmlhttprequest2",
      "xml",
      "http",
      "request2",
    ]);
    expect(tokenizeQuery("base64Encode")).toEqual(["base64encode", "base64", "encode"]);
  });
});

describe("separator boundaries", () => {
  it("keeps scoped package names joined while exposing components", () => {
    expect(tokenizeQuery("@engram/core")).toEqual(["engram/core", "engram", "core"]);
  });

  it("splits colon-joined names", () => {
    expect(tokenizeQuery("command:subcommand")).toEqual([
      "command:subcommand",
      "command",
      "subcommand",
    ]);
  });

  it("splits hyphenated words with a leading capital", () => {
    expect(tokenizeQuery("E-mail")).toEqual(["e-mail", "e", "mail"]);
  });

  it("tokenizes POSIX paths with extension awareness", () => {
    expect(tokenizeQuery("packages/core/src/search.ts")).toEqual([
      "packages/core/src/search.ts",
      "packages",
      "core",
      "src",
      "search",
      "ts",
      "search.ts",
    ]);
  });
});

describe("unicode normalization", () => {
  it("folds Latin accents, precomposed and decomposed", () => {
    expect(tokenizeQuery("Café")).toEqual(["cafe"]);
    expect(tokenizeQuery("cafe\u0301")).toEqual(["cafe"]);
    expect(tokenizeQuery("Ångström")).toEqual(["angstrom"]);
  });

  it("lowercases uniformly", () => {
    expect(tokenizeQuery("HELLO")).toEqual(["hello"]);
  });

  it("non-Latin scripts survive as normalized whole tokens", () => {
    expect(tokenizeQuery("Привет")).toEqual(["привет"]);
    expect(tokenizeQuery("такой")).toEqual(["такой"]);
    expect(tokenizeQuery("記憶")).toEqual(["記憶"]);
  });

  it("splits mixed-script terms only on case boundaries", () => {
    expect(tokenizeQuery("記憶Search")).toEqual(["記憶search", "記憶", "search"]);
  });
});

describe("safety", () => {
  it("returns [] for empty, whitespace-only, and punctuation-only queries", () => {
    expect(tokenizeQuery("")).toEqual([]);
    expect(tokenizeQuery("   \t\n  ")).toEqual([]);
    expect(tokenizeQuery("!!! --- ???")).toEqual([]);
    expect(tokenizeQuery("@#$%^&*()")).toEqual([]);
    expect(tokenizeQuery("\u0000")).toEqual([]);
  });

  it("never throws on malformed input", () => {
    expect(() => tokenizeQuery("\uD800")).not.toThrow();
    expect(tokenizeQuery("\uD800")).toEqual([]);
  });
});

describe("determinism and dedupe", () => {
  it("yields identical output for repeated calls", () => {
    const q = "parseURLConfig @engram/core Café";
    expect(tokenizeQuery(q)).toEqual(tokenizeQuery(q));
  });

  it("removes duplicates, keeping the first occurrence", () => {
    expect(tokenizeQuery("Café café CAFÉ")).toEqual(["cafe"]);
    expect(tokenizeQuery("parse parse")).toEqual(["parse"]);
  });

  it("emits the exact whole form before its subtokens", () => {
    expect(tokenizeQuery("search.ts")[0]).toBe("search.ts");
  });
});

describe("mixed queries", () => {
  it("combines conventions with cross-token dedupe", () => {
    expect(tokenizeQuery("parseEngramStore.add @engram/core packages/core/src/search.ts")).toEqual([
      "parseengramstore.add",
      "parse",
      "engram",
      "store",
      "add",
      "engram/core",
      "core",
      "packages/core/src/search.ts",
      "packages",
      "src",
      "search",
      "ts",
      "search.ts",
    ]);
  });

  it("handles a realistic retrieval query", () => {
    expect(tokenizeQuery("engram-cli --save-dev NodeServices")).toEqual([
      "engram-cli",
      "engram",
      "cli",
      "save-dev",
      "save",
      "dev",
      "nodeservices",
      "node",
      "services",
    ]);
  });
});

describe("call-form tokens stay unexpanded (ENG-60 rank-side contract)", () => {
  it("emits no joined bare identifier for a call-form term", () => {
    // The bare identifier recovery for call forms lives in the ranker
    // (ENG-60): the emitted token stream keeps the whole form plus the
    // camelCase/separator expansion, never the joined components.
    expect(tokenizeQuery("fetchBundle(outPath)")).toEqual([
      "fetchbundle(outpath",
      "fetch",
      "bundle",
      "out",
      "path",
    ]);
  });
});
