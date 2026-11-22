import { fileURLToPath } from "node:url";
import { loadCaptureCorpus } from "../capture-corpus.js";
import { measureCaptureCorpus } from "../capture-score.js";

const root = fileURLToPath(new URL("../../../../corpus/capture/", import.meta.url));
console.log(JSON.stringify(measureCaptureCorpus(loadCaptureCorpus(root)), null, 2));
