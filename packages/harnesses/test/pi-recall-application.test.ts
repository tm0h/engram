import { expect, it, vi } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  runPrintMode,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { projectConfigPath, projectEngramsDir } from "@engram/core";
import engramExtension from "../src/pi/index.js";
import { autoContextOp, runOpAtDirectory } from "../src/shared/index.js";

const tasks = [
  { prompt: "Configure orchid ttl", output: { setting: "orchid_ttl", value: 604800 } },
  { prompt: "Configure cedar retries", output: { setting: "cedar_retries", value: 3 } },
  { prompt: "Configure orchid seismology", output: { setting: "orchid_seismology", value: null } },
] as const;

const seed = (cwd: string, id: string, title: string, body: string) =>
  writeFileSync(
    join(projectEngramsDir(cwd), `${id}-${title.toLowerCase().replace(" ", "-")}.md`),
    [
      "---",
      `id: "${id}"`,
      `title: ${title}`,
      "type: decision",
      "pinned: true",
      "tags: []",
      "scope: project",
      "created: 2026-08-16T10:00:00.000Z",
      "updated: 2026-08-16T10:00:00.000Z",
      "---",
      body,
      "",
    ].join("\n"),
  );

/** Apply a recorded assignment to a proposed configuration change. Without a value,
 * decline the change. The fixture knows the format, with values supplied by memory. */
const proposeChange: FauxResponseFactory = ({ messages, systemPrompt }) => {
  const user = messages.filter((message) => message.role === "user").at(-1);
  const prompt =
    typeof user?.content === "string"
      ? user.content
      : user?.content[0]?.type === "text"
        ? user.content[0].text
        : "";
  const [, service, key] = /^Configure ([a-z]+) ([a-z]+)$/.exec(prompt) ?? [];
  const setting = `${service}_${key}`;
  const value = new RegExp(`\\b${setting}=(\\d+)\\b`).exec(systemPrompt ?? "")?.[1];
  return fauxAssistantMessage(JSON.stringify({ setting, value: value ? Number(value) : null }));
};

it("improves configuration proposals over static bootstrap in Pi print and JSON modes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "engram-pi-application-"));
  const home = join(cwd, "home");
  const agentDir = join(cwd, "agent");
  vi.stubEnv("HOME", home);
  try {
    mkdirSync(join(home, ".engram"), { recursive: true });
    mkdirSync(projectEngramsDir(cwd), { recursive: true });
    writeFileSync(projectConfigPath(cwd), JSON.stringify({ version: 1, tracked: true }));
    seed(cwd, "0001", "Orchid TTL", "Set orchid_ttl=604800 for published assets.");
    seed(cwd, "0002", "Cedar retries", "Set cedar_retries=3 for queued jobs.");
    const bootstrap = await runOpAtDirectory(cwd, autoContextOp());
    expect(bootstrap.text).toContain("Orchid TTL");
    expect(bootstrap.text).toContain("Cedar retries");
    const staticExtension: ExtensionFactory = (pi) => {
      pi.on("before_agent_start", (event) => ({
        systemPrompt: event.systemPrompt + "\n\n" + bootstrap.text,
      }));
    };

    for (const mode of ["text", "json"] as const) {
      for (const delivery of ["static", "recall"] as const) {
        const captured: string[] = [];
        const respond: FauxResponseFactory = (context, options, state, model) => {
          captured.push(context.systemPrompt ?? "");
          if (delivery === "recall" && captured.length === 1) {
            return fauxAssistantMessage("", {
              stopReason: "error",
              errorMessage: "503 Service Unavailable",
            });
          }
          return proposeChange(context, options, state, model);
        };
        const faux = fauxProvider();
        faux.setResponses(Array.from({ length: tasks.length + 1 }, () => respond));
        const modelRuntime = await ModelRuntime.create({
          authPath: join(agentDir, "auth.json"),
          modelsPath: join(agentDir, "models.json"),
          refreshOnCreate: false,
        });
        modelRuntime.registerNativeProvider(faux.provider);
        const settingsManager = SettingsManager.inMemory({
          retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
        });
        const host = await createAgentSessionRuntime(
          async (options) => {
            const services = await createAgentSessionServices({
              ...options,
              modelRuntime,
              settingsManager,
              resourceLoaderOptions: {
                systemPrompt: "Project base",
                noContextFiles: true,
                noSkills: true,
                extensionFactories: [
                  (pi) => {
                    pi.on("before_agent_start", (event) => ({
                      systemPrompt: event.systemPrompt + "\nEarlier extension",
                    }));
                  },
                  delivery === "static" ? staticExtension : engramExtension,
                ],
              },
            });
            const session = await createAgentSessionFromServices({
              ...options,
              services,
              model: faux.getModel(),
              noTools: "all",
            });
            return { ...session, services, diagnostics: services.diagnostics };
          },
          { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
        );

        const stdout: string[] = [];
        const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
        const output = vi
          .spyOn(process.stdout, "write")
          .mockImplementation((chunk, callback?: BufferEncoding | (() => void)) => {
            stdout.push(String(chunk));
            if (typeof callback === "function") callback();
            return true;
          });
        let exitCode: number;
        try {
          exitCode = await runPrintMode(host, {
            mode,
            messages: tasks.map(({ prompt }) => prompt),
          });
        } finally {
          output.mockRestore();
          const errors = [...stderr.mock.calls];
          stderr.mockRestore();
          expect(errors).toEqual([]);
        }
        expect(exitCode).toBe(0);
        const expected = tasks.map(({ output }) =>
          delivery === "recall" ? output : { ...output, value: null },
        );
        if (mode === "text") {
          expect(stdout.join("")).toBe(JSON.stringify(expected.at(-1)) + "\n");
        } else {
          // Every line is JSON, and the final assistant responses contain only proposals.
          const lines = stdout
            .join("")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(
            lines
              .filter(
                (event) =>
                  event.type === "message_end" &&
                  event.message.role === "assistant" &&
                  event.message.stopReason === "stop",
              )
              .map((event) => JSON.parse(event.message.content[0].text)),
          ).toEqual(expected);
          expect(stdout.join("")).not.toContain("<engram-memory>");
        }
        if (delivery === "recall") {
          expect(captured).toHaveLength(4);
          expect(captured[1]).toBe(captured[0]); // retry
          expect(captured[0]).toContain("orchid_ttl=604800");
          expect(captured[2]).toContain("cedar_retries=3");
          expect(captured[2]).not.toContain("orchid_ttl=");
          for (const prompt of captured.slice(0, 3)) {
            expect(prompt).toContain("Project base");
            expect(prompt).toContain("Earlier extension");
            expect(prompt.match(/<engram-memory>/g)).toHaveLength(1);
          }
          expect(captured[3]).not.toContain("<engram-memory>");
        }

        const responses = host.session.state.messages
          .flatMap((message) =>
            message.role === "assistant" && message.stopReason === "stop" ? message.content : [],
          )
          .map((block) => (block.type === "text" ? JSON.parse(block.text) : null));
        const score = responses.filter(
          (answer, i) => JSON.stringify(answer) === JSON.stringify(tasks[i]?.output),
        ).length;
        expect(score).toBe(delivery === "recall" ? 3 : 1);
      }
    }
  } finally {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
});
