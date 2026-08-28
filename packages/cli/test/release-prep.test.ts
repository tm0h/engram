/**
 * Release-prep script tests: the five synchronized version locations, the
 * Pi README pins, and the CHANGELOG rotation are pure string transforms in
 * scripts/release-prep.ts. These tests pin the exact contract (including
 * fail-closed refusals) without touching the working tree.
 */
import { describe, expect, it } from "vite-plus/test";
import { parseVersion, prepareRelease, updateChangelog } from "../../../scripts/release-prep.ts";

const V040 = "0.4.0";

const cliPkg = (version: string): string =>
  `${JSON.stringify(
    {
      name: "engram-cli",
      version,
      repository: { type: "git", url: "git+https://github.com/tm0h/engram.git" },
    },
    null,
    2,
  )}\n`;

const baseInput = (version: string) => ({
  cliPkg: cliPkg(version),
  indexTs: `program\n  .name("engram")\n  .version("${version}");\n`,
  harnessesPkg: cliPkg(version).replace("engram-cli", "@engram/harnesses"),
  pluginJson: `{ "name": "engram", "version": "${version}" }\n`,
  binSh: `exec npx -y engram-cli@${version} "$@"\n`,
  piReadme:
    `{ "packages": ["npm:engram-cli@${version}"] }\n` +
    `\`pi install git:github.com/tm0h/engram@v${version}\`.\n`,
  changelog: `# Changelog\n\n## [Unreleased]\n\n## [${V040}] - 2026-08-28\n\n### Added\n\n- Thing ([#16])\n\n[#16]: https://github.com/tm0h/engram/pull/16\n[${V040}]: https://github.com/tm0h/engram/releases/tag/v${V040}\n\n## [0.3.0] - 2026-08-19\n`,
});

describe("parseVersion", () => {
  it("accepts strict X.Y.Z with an optional v prefix and normalizes it away", () => {
    expect(parseVersion("1.2.3")).toBe("1.2.3");
    expect(parseVersion("v1.2.3")).toBe("1.2.3");
    expect(parseVersion("0.4.0")).toBe("0.4.0");
  });

  it("rejects prerelease, metadata, leading zeros, and malformed input", () => {
    for (const bad of [
      "1.2",
      "1.2.3.4",
      "01.2.3",
      "1.02.3",
      "1.2.3-rc.1",
      "1.2.3+build",
      "release-0.4.0",
      "",
      "abc",
    ]) {
      expect(() => parseVersion(bad)).toThrow(/strict X\.Y\.Z/);
    }
  });
});

describe("prepareRelease", () => {
  it("bumps all five version locations plus both Pi README pins", () => {
    const out = prepareRelease(baseInput(V040), "0.5.0", "2026-09-01");
    expect(JSON.parse(out.files.cliPkg).version).toBe("0.5.0");
    expect(out.files.indexTs).toContain('.version("0.5.0")');
    expect(JSON.parse(out.files.harnessesPkg).version).toBe("0.5.0");
    expect(JSON.parse(out.files.pluginJson).version).toBe("0.5.0");
    expect(out.files.binSh).toContain("engram-cli@0.5.0");
    expect(out.files.piReadme).toContain("npm:engram-cli@0.5.0");
    expect(out.files.piReadme).toContain("engram@v0.5.0");
    expect(out.files.piReadme).not.toContain("@0.4.0");
    expect(out.files.binSh).not.toContain("@0.4.0");
  });

  it("leaves JSON formatting stable apart from the version value", () => {
    const out = prepareRelease(baseInput(V040), "0.5.0", "2026-09-01");
    expect(out.files.cliPkg).toBe(
      cliPkg(V040).replace(`"version": "${V040}"`, '"version": "0.5.0"'),
    );
  });

  it("rotates the CHANGELOG: moves Unreleased content under the new heading and appends the tag link ref", () => {
    const input = baseInput(V040);
    input.changelog =
      "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- New thing ([#18])\n\n[#18]: https://github.com/tm0h/engram/pull/18\n\n## [0.4.0] - 2026-08-28\n";
    const out = prepareRelease(input, "0.5.0", "2026-09-01");
    expect(out.files.changelog).toBe(
      "# Changelog\n\n" +
        "## [Unreleased]\n\n" +
        "## [0.5.0] - 2026-09-01\n\n" +
        "### Added\n\n" +
        "- New thing ([#18])\n\n" +
        "[#18]: https://github.com/tm0h/engram/pull/18\n" +
        "[0.5.0]: https://github.com/tm0h/engram/releases/tag/v0.5.0\n\n" +
        "## [0.4.0] - 2026-08-28\n",
    );
  });

  it("creates an empty section (heading plus link ref) when Unreleased is empty", () => {
    const out = prepareRelease(baseInput(V040), "0.5.0", "2026-09-01");
    expect(out.files.changelog).toContain(
      "## [Unreleased]\n\n## [0.5.0] - 2026-09-01\n\n[0.5.0]: https://github.com/tm0h/engram/releases/tag/v0.5.0\n\n## [0.4.0]",
    );
  });

  it("refuses when a CHANGELOG section for the version already exists", () => {
    expect(() => prepareRelease(baseInput(V040), V040, "2026-09-01")).toThrow(/already exists/);
  });

  it("refuses when the five locations have drifted apart", () => {
    const input = baseInput(V040);
    input.indexTs = '.version("0.3.0")\n';
    expect(() => prepareRelease(input, "0.5.0", "2026-09-01")).toThrow(
      /drifted|in sync|do not agree/,
    );
  });

  it("refuses when the Pi README pins disagree with the locations", () => {
    const input = baseInput(V040);
    input.piReadme = input.piReadme.replace("@v0.4.0", "@v0.3.0");
    expect(() => prepareRelease(input, "0.5.0", "2026-09-01")).toThrow(
      /drifted|in sync|do not agree/,
    );
  });

  it("refuses a malformed date", () => {
    expect(() => prepareRelease(baseInput(V040), "0.5.0", "09-01-2026")).toThrow(/date/i);
  });

  it("refuses an invalid version", () => {
    expect(() => prepareRelease(baseInput(V040), "0.5.0-rc.1", "2026-09-01")).toThrow(
      /strict X\.Y\.Z/,
    );
  });
});

describe("updateChangelog", () => {
  it("keeps the Unreleased heading in place", () => {
    const out = updateChangelog(
      baseInput(V040).changelog,
      "0.5.0",
      "2026-09-01",
      "https://github.com/tm0h/engram",
    );
    expect(out.indexOf("## [Unreleased]")).toBeLessThan(out.indexOf("## [0.5.0]"));
    expect(out.indexOf("## [0.5.0]")).toBeLessThan(out.indexOf("## [0.4.0]"));
  });

  it("throws when the Unreleased heading is missing", () => {
    expect(() =>
      updateChangelog(
        "# Changelog\n\n## [0.4.0] - 2026-08-28\n",
        "0.5.0",
        "2026-09-01",
        "https://github.com/tm0h/engram",
      ),
    ).toThrow(/Unreleased/);
  });
});
