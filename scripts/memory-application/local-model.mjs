// Optional reproducible baseline server. Install node-llama-cpp outside the workspace.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const [runtime, modelPath, port = "8080"] = process.argv.slice(2);
if (!runtime || !modelPath) {
  throw new Error("Pass the node-llama-cpp install directory and the GGUF file");
}
const require = createRequire(resolve(runtime, "package.json"));
const { getLlama, LlamaChatSession } = await import(
  pathToFileURL(require.resolve("node-llama-cpp")).href
);
const llama = await getLlama({ gpu: false });
const model = await llama.loadModel({ modelPath: resolve(modelPath) });
const context = await model.createContext({ contextSize: 4096, threads: 4 });
const grammar = await llama.getGrammarFor("json");

createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    let result;
    if (request.url === "/tokenize") {
      result = { tokens: model.tokenize(input.content) };
    } else if (request.url === "/v1/chat/completions") {
      const messages = input.messages;
      const session = new LlamaChatSession({ contextSequence: context.getSequence() });
      try {
        session.setChatHistory(
          messages
            .slice(0, -1)
            .map(({ role, content }) =>
              role === "assistant"
                ? { type: "model", response: [content] }
                : { type: role, text: content },
            ),
        );
        const content = await session.prompt(messages.at(-1).content, {
          grammar,
          temperature: input.temperature,
          maxTokens: input.max_tokens,
          seed: input.seed,
        });
        result = { choices: [{ message: { content } }] };
      } finally {
        session.dispose({ disposeSequence: true });
      }
    } else {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
  } catch (error) {
    console.error(error);
    response.writeHead(500).end();
  }
}).listen(Number(port), "127.0.0.1", () => console.log("Model ready on " + port));
