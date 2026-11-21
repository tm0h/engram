import { createHash, randomUUID } from "node:crypto";
import { Effect, Option, Result, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { writeAtomicFile } from "./atomic-file.js";
import { ConfigRepo } from "./config.js";
import {
  AuditId,
  CaptureReport,
  DurableClass,
  Harness,
  Provenance,
  capturePolicy,
  day,
  measureProjectSample,
  syntheticBaseline,
  type Sample,
} from "./capture-policy.js";
import { ValidationError } from "./errors.js";
import { projectConfigPath, projectDir, projectEngramsDir } from "./paths.js";
import { type CaptureSource, type PendingCandidate, withQueueLock } from "./pending-store.js";
import { scanContent } from "./secrets.js";
import { EngramStore } from "./store.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const policyId = hash(capturePolicy);
const maxAudit = 512;
const hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const canonical = Schema.String.check(Schema.isPattern(/^[a-z0-9]{26}$/));
const time = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const SourceRef = Schema.Struct({
  harness: Harness,
  event: Schema.Literals([
    "agent_settled",
    "session_before_compact",
    "session_shutdown",
    "command.execute.before",
  ]),
  provenance: Provenance,
  session: hex,
  evidence: hex,
});
const SampleSchema = Schema.Struct({
  ...SourceRef.fields,
  type: DurableClass,
  candidate: Schema.String.check(Schema.isPattern(/^pending-[a-f0-9-]{36}$/)),
});
const Reasons = Schema.Literals([
  "disabled",
  "enabled",
  "evidence_accepted",
  "evidence_failed",
  "evidence_expired",
  "quality_failed",
  "review_due",
  "policy_changed",
  "config_unavailable",
  "review_only",
  "provenance_unverified",
  "sensitive_content",
  "invalid_candidate",
  "store_invalid",
  "exact_duplicate",
  "likely_duplicate",
  "possible_conflict",
  "write_unavailable",
  "write_authorized",
  "recorded",
  "write_interrupted",
  "capture_interrupted",
  "publication_observed",
]);
type Reason = typeof Reasons.Type;
const Audit = Schema.Struct({
  id: AuditId,
  at: time,
  actor: time,
  policy: hex,
  policyVersion: time,
  evidenceVersion: Schema.optionalKey(time),
  evidenceId: Schema.optionalKey(hex),
  reason: Reasons,
  result: Schema.Literals([
    "pending",
    "rejected",
    "authorized",
    "recorded",
    "reconciled",
    "transition",
  ]),
  sample: Schema.optionalKey(SampleSchema),
  source: Schema.optionalKey(SourceRef),
  canonicalId: Schema.optionalKey(canonical),
  canonicalChecksPassed: Schema.optionalKey(Schema.Literal(true)),
});
type Audit = typeof Audit.Type;
const State = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  project: hex,
  consent: Schema.optionalKey(Schema.Struct({ actor: time, at: time, policy: hex })),
  report: Schema.optionalKey(Schema.Struct({ at: time, value: CaptureReport })),
  audit: Schema.Array(Audit).check(Schema.isMaxLength(maxAudit)),
});
type State = typeof State.Type;

const fail = (message: string) => new ValidationError({ message });
const controlsUnavailable = () => fail("Project capture controls are unavailable.");
const strict = { onExcessProperty: "error" } as const;
const basename = "state.json";
const isExists = (error: { reason: { _tag: string } }) => error.reason._tag === "AlreadyExists";

const checkOwned = Effect.fnUntraced(function* (
  file: string,
  actor: number,
  type: "Directory" | "File",
  privateMode = false,
) {
  const fs = yield* FileSystem;
  const stat = yield* fs.stat(file);
  if (
    stat.type !== type ||
    Option.getOrUndefined(stat.uid) !== actor ||
    (stat.mode & (privateMode ? 0o077 : 0o022)) !== 0 ||
    (type === "File" && Option.getOrUndefined(stat.nlink) !== 1) ||
    (yield* fs.realPath(file)) !== file
  ) {
    return yield* Effect.fail(controlsUnavailable());
  }
  return stat;
});

const openControls = Effect.fnUntraced(function* () {
  const store = yield* EngramStore;
  const fs = yield* FileSystem;
  const path = yield* Path;
  const root = Option.getOrUndefined(yield* store.projectRoot());
  const actor = process.getuid?.();
  if (root === undefined || actor === undefined || actor !== process.geteuid?.()) {
    return yield* Effect.fail(controlsUnavailable());
  }
  const actualRoot = yield* fs.realPath(root);
  const rootStat = yield* checkOwned(actualRoot, actor, "Directory");
  yield* checkOwned(projectDir(actualRoot), actor, "Directory");
  yield* checkOwned(projectConfigPath(actualRoot), actor, "File");
  const inode = Option.getOrUndefined(rootStat.ino);
  if (inode === undefined) return yield* Effect.fail(controlsUnavailable());
  const project = hash([actualRoot, rootStat.dev, inode, actor]);
  const directory = path.join(projectDir(actualRoot), "capture");
  yield* fs
    .makeDirectory(directory, { mode: 0o700 })
    .pipe(Effect.catchIf(isExists, () => Effect.void));
  yield* checkOwned(directory, actor, "Directory", true);
  return { actualRoot, project, directory, actor };
});

type Controls = {
  readonly root: string;
  readonly get: () => State;
  readonly persist: (state: State) => ReturnType<typeof writeAtomicFile>;
  readonly event: (
    record: Omit<
      Audit,
      "id" | "at" | "actor" | "policy" | "policyVersion" | "evidenceId" | "evidenceVersion"
    >,
  ) => Audit;
};

const withControls = <A, E, R>(use: (controls: Controls) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    const { actualRoot, project, directory, actor } = yield* openControls();
    return yield* withQueueLock(
      path.join(directory, ".lock"),
      Effect.gen(function* () {
        const file = path.join(directory, basename);
        // Git ignores this directory even when project memories are tracked.
        const ignore = path.join(directory, ".gitignore");
        if (!(yield* fs.exists(ignore))) {
          yield* writeAtomicFile(directory, ".gitignore", "/*\n", { mode: 0o600 }).pipe(
            Effect.catchIf(isExists, () => Effect.void),
          );
        }
        yield* checkOwned(ignore, actor, "File", true);
        if ((yield* fs.readFileString(ignore)) !== "/*\n") {
          return yield* Effect.fail(controlsUnavailable());
        }
        const stat = yield* checkOwned(file, actor, "File", true).pipe(
          Effect.catchIf(
            (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
            () => Effect.succeed(undefined),
          ),
        );
        let state: State = { schemaVersion: 1, project, audit: [] };
        if (stat) {
          if (Number(stat.size) > 1_000_000) return yield* Effect.fail(controlsUnavailable());
          const raw = yield* fs.readFileString(file);
          state = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(State))(raw, strict).pipe(
            Effect.mapError(controlsUnavailable),
          );
          if (
            state.project !== project ||
            (state.consent && state.consent.actor !== actor) ||
            (state.report && state.report.value.project !== project)
          )
            return yield* Effect.fail(controlsUnavailable());
        }
        const persist: Controls["persist"] = (next) =>
          Effect.gen(function* () {
            yield* writeAtomicFile(directory, basename, JSON.stringify(next) + "\n", {
              mode: 0o600,
              replace: true,
            });
            state = next;
          });
        const event: Controls["event"] = (row) => ({
          ...row,
          id: randomUUID(),
          at: Date.now(),
          actor,
          policy: policyId,
          policyVersion: capturePolicy.version,
          ...(state.report && {
            evidenceId: hash(state.report.value),
            evidenceVersion: state.report.value.schemaVersion,
          }),
        });
        return yield* use({ root: actualRoot, get: () => state, persist, event });
      }),
      "Project capture controls are busy.",
    );
  });

const append = (state: State, row: Audit): State => ({
  ...state,
  audit: [...state.audit, row].slice(-maxAudit),
});

const population = (audit: readonly Audit[], now: number): Sample[] =>
  audit
    .filter(
      (row) =>
        row.sample &&
        (row.result === "pending" || row.result === "recorded" || row.result === "reconciled") &&
        row.policy === policyId &&
        row.at >= now - capturePolicy.windowDays * day &&
        row.at <= now,
    )
    .slice(-capturePolicy.maxPopulation)
    .flatMap(({ id, at, sample }) => (sample ? [{ id, at, ...sample }] : []));

function assess(state: State, now: number) {
  const samples = population(state.audit, now);
  const report = state.report;
  if (!report) return { reason: "review_only" } as const;
  if (report.value.policy !== policyId || (state.consent && state.consent.policy !== policyId)) {
    return { reason: "policy_changed" } as const;
  }
  if (
    (state.consent && state.consent.at > now) ||
    report.at > now ||
    report.at + capturePolicy.expiryDays * day <= now
  ) {
    return { reason: "evidence_expired" } as const;
  }
  const end = samples.findIndex(({ id }) => id === report.value.through);
  if (end < 0) return { reason: "quality_failed" } as const;
  const reportIds = new Set(report.value.assessments.map(({ id }) => id));
  const window = samples.slice(0, end + 1).filter(({ id }) => reportIds.has(id));
  // The submitted report was complete at acceptance. Outcomes may age out
  // while it is active. Recompute the thresholds on the surviving window.
  const retained = new Set(window.map(({ id }) => id));
  const score = measureProjectSample(window, {
    ...report.value,
    assessments: report.value.assessments.filter(({ id }) => retained.has(id)),
  });
  if (!syntheticBaseline().passed || !score.passed)
    return { reason: "quality_failed", score } as const;
  const unassessed = samples.length - end - 1;
  if (unassessed >= capturePolicy.maxUnassessed)
    return { reason: "review_due", score, unassessed } as const;
  return { reason: "passed", score, unassessed } as const;
}

// The intent and its deterministic canonical ID are persisted before writing.
// A later operation resolves an interrupted intent by its exact source reference.
const recover = Effect.fnUntraced(function* (controls: Controls) {
  const state = controls.get();
  const intent = state.audit.at(-1);
  if (intent?.result !== "authorized") return;
  const store = yield* EngramStore;
  const scanned = yield* store.scan("project");
  if (
    scanned.diagnostics.some(
      ({ severity, code }) => severity === "error" || code === "schema_version_unsupported",
    )
  )
    return yield* Effect.fail(controlsUnavailable());
  const entry = scanned.entries.find(({ id }) => id === intent.canonicalId);
  if (entry && entry.sourceRef !== intent.sample?.candidate) {
    return yield* Effect.fail(controlsUnavailable());
  }
  const resolved = {
    ...intent,
    result: entry ? "reconciled" : "pending",
    reason: entry ? "publication_observed" : "write_interrupted",
  } as const;
  yield* controls.persist({ ...state, audit: [...state.audit.slice(0, -1), resolved] });
});

const effectiveConfig = Effect.fnUntraced(function* (controls: Controls) {
  const cfg = yield* ConfigRepo;
  yield* checkOwned(projectConfigPath(controls.root), process.geteuid!(), "File");
  yield* checkOwned(projectEngramsDir(controls.root), process.geteuid!(), "Directory");
  if ((yield* cfg.validateProject(controls.root)).length || (yield* cfg.validateGlobal()).length) {
    return yield* Effect.fail(controlsUnavailable());
  }
  const project = yield* cfg.loadProject(controls.root);
  if (project.secretScan !== undefined && project.secretScan !== "block") {
    return yield* Effect.fail(controlsUnavailable());
  }
});

const suspend = (controls: Controls, reason: Reason) =>
  controls.persist(
    append(
      { ...controls.get(), consent: undefined },
      controls.event({ reason, result: "transition" }),
    ),
  );

const refresh = Effect.fnUntraced(function* (controls: Controls) {
  yield* recover(controls);
  const state = controls.get();
  const decision = assess(state, Date.now());
  if (state.consent && decision.reason !== "passed") yield* suspend(controls, decision.reason);
  return decision;
});

export const captureControl = (
  action: "status" | "evidence" | "enable" | "disable",
  input?: string,
) =>
  withControls((controls) =>
    Effect.gen(function* () {
      // Disable can always revoke consent once the state is readable, including
      // while recovery or canonical validation is unavailable.
      if (action === "disable") {
        const state = controls.get();
        const disabled = controls.event({ reason: "disabled", result: "transition" });
        // Leave an unresolved intent last so recovery can still reconcile it.
        const intent = state.audit.at(-1);
        const disabledState = { ...state, consent: undefined };
        yield* controls.persist(
          intent?.result === "authorized"
            ? append(
                append({ ...disabledState, audit: state.audit.slice(0, -1) }, disabled),
                intent,
              )
            : append(disabledState, disabled),
        );
        return { status: "review-only", reason: "disabled" };
      }
      let decision = yield* refresh(controls);
      if (action === "evidence") {
        const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CaptureReport))(
          input,
          strict,
        ).pipe(Effect.mapError(() => fail("Invalid capture evidence report.")));
        const state = controls.get();
        const now = Date.now();
        const samples = population(state.audit, now);
        if (
          report.project !== state.project ||
          report.policy !== policyId ||
          report.through !== samples.at(-1)?.id
        ) {
          return yield* Effect.fail(
            fail("Capture evidence does not match this project, policy, or sample window."),
          );
        }
        const measured = measureProjectSample(samples, report);
        if (!measured.complete)
          return yield* Effect.fail(
            fail("Capture evidence must assess the complete sample window."),
          );
        const passed = syntheticBaseline().passed && measured.passed;
        if (
          passed &&
          state.report?.value.through === report.through &&
          decision.reason !== "quality_failed"
        ) {
          return yield* Effect.fail(
            fail("Capture evidence must cover new project review outcomes."),
          );
        }
        const next = {
          ...state,
          report: { at: now, value: report },
          consent: passed ? state.consent : undefined,
        };
        yield* controls.persist(
          append(next, {
            ...controls.event({
              reason: passed ? "evidence_accepted" : "evidence_failed",
              result: "transition",
            }),
            evidenceId: hash(report),
            evidenceVersion: report.schemaVersion,
          }),
        );
        decision = assess(controls.get(), now);
      }
      const state = controls.get();
      if (
        decision.reason === "passed" &&
        Result.isFailure(yield* Effect.result(effectiveConfig(controls)))
      ) {
        if (state.consent) yield* suspend(controls, "config_unavailable");
        if (action === "enable") return yield* Effect.fail(controlsUnavailable());
        return { status: "review-only", reason: "config_unavailable", ...details(controls.get()) };
      }
      if (action === "enable") {
        if (decision.reason !== "passed")
          return yield* Effect.fail(fail("Automatic recording requires passing project evidence."));
        const event = controls.event({ reason: "enabled", result: "transition" });
        yield* controls.persist(
          append(
            {
              ...controls.get(),
              consent: { actor: event.actor, at: event.at, policy: policyId },
            },
            event,
          ),
        );
      }
      return {
        status: controls.get().consent
          ? "active"
          : decision.reason === "passed"
            ? "eligible"
            : "review-only",
        ...decision,
        ...details(controls.get()),
      };
    }),
  );

function details(state: State) {
  const samples = population(state.audit, Date.now());
  return {
    project: state.project,
    policy: policyId,
    requirements: capturePolicy,
    synthetic: syntheticBaseline(),
    through: samples.at(-1)?.id ?? null,
    samples,
    report: state.report ?? null,
    audit: state.audit,
  };
}

function sourceRef(source: CaptureSource, project: string) {
  return {
    harness: source.harness,
    event: source.event,
    provenance:
      source.evidence.length && source.evidence.every(({ origin }) => origin === "user")
        ? "direct_user"
        : "other",
    session: hash([project, source.harness, source.sessionId]),
    evidence: hash([project, source.harness, source.sessionId, source.evidence]),
  } as const;
}

function sampleFor(candidate: PendingCandidate, source: CaptureSource, project: string) {
  const type = candidate.proposed.type;
  if (type !== "decision" && type !== "fact" && type !== "issue") return;
  return { ...sourceRef(source, project), type, candidate: candidate.id };
}

export const auditCaptureDuplicate = (source: CaptureSource) =>
  withControls((controls) =>
    Effect.gen(function* () {
      yield* refresh(controls);
      yield* controls.persist(
        append(
          controls.get(),
          controls.event({
            result: "rejected",
            reason: "exact_duplicate",
            source: sourceRef(source, controls.get().project),
          }),
        ),
      );
    }),
  ).pipe(Effect.ignore);

export const recordProjectCapture = (
  candidate: PendingCandidate,
  signal: AbortSignal | undefined,
  recheck: () => boolean,
) =>
  withControls((controls) =>
    Effect.gen(function* () {
      const source = candidate.captureSource;
      if (candidate.scope !== "project" || !source) return { status: "pending" } as const;
      const decision = yield* refresh(controls);
      const state = controls.get();
      let sample = sampleFor(candidate, source, state.project);
      // Replayed evidence is useful for auditing, but counts only once in the sample.
      if (sample && state.audit.some((row) => row.sample?.evidence === sample?.evidence))
        sample = undefined;
      const pending = (reason: Reason) =>
        controls
          .persist(
            append(
              controls.get(),
              controls.event({ result: "pending", reason, ...(sample && { sample }) }),
            ),
          )
          .pipe(Effect.as({ status: "pending", reason } as const));
      if (!state.consent || decision.reason !== "passed") {
        return yield* pending(decision.reason === "passed" ? "review_only" : decision.reason);
      }
      if (sample?.provenance !== "direct_user") return yield* pending("provenance_unverified");
      if (signal?.aborted) return yield* pending("capture_interrupted");
      if (Result.isFailure(yield* Effect.result(effectiveConfig(controls)))) {
        yield* suspend(controls, "config_unavailable");
        return yield* pending("config_unavailable");
      }
      const store = yield* EngramStore;
      const fs = yield* FileSystem;
      const path = yield* Path;
      const configRepo = yield* ConfigRepo;
      let intent: Audit | undefined;
      let guardReason: Reason | undefined;
      const write = yield* Effect.result(
        store.approvePending(candidate, {
          automatic: (id) =>
            Effect.gen(function* () {
              const config = yield* Effect.result(effectiveConfig(controls));
              if (Result.isFailure(config)) {
                yield* suspend(controls, "config_unavailable");
                return yield* Effect.fail(controlsUnavailable());
              }
              const current = assess(controls.get(), Date.now());
              if (current.reason !== "passed") {
                yield* suspend(controls, current.reason);
                return yield* Effect.fail(controlsUnavailable());
              }
              guardReason = signal?.aborted
                ? "capture_interrupted"
                : !recheck()
                  ? "provenance_unverified"
                  : scanContent(candidate.sourceExcerpt).length > 0
                    ? "sensitive_content"
                    : undefined;
              if (guardReason) return yield* Effect.fail(controlsUnavailable());
              intent = controls.event({
                result: "authorized",
                reason: "write_authorized",
                sample,
                canonicalId: id,
                canonicalChecksPassed: true,
              });
              yield* controls.persist(append(controls.get(), intent));
            }).pipe(
              Effect.provideService(ConfigRepo, configRepo),
              Effect.provideService(FileSystem, fs),
              Effect.provideService(Path, path),
            ),
        }),
      );
      if (Result.isFailure(write)) {
        if (intent && controls.get().audit.at(-1)?.id === intent.id) {
          yield* recover(controls);
          return { status: "pending", reason: "write_unavailable" } as const;
        }
        const error = write.failure;
        if (error._tag === "IntegrityCheckFailedError") {
          yield* suspend(controls, "store_invalid");
          return yield* pending("store_invalid");
        }
        const reason =
          guardReason ??
          (error._tag === "WriteAdvisoryError"
            ? error.candidates[0].kind
            : error._tag === "SecretScanBlockedError"
              ? "sensitive_content"
              : error._tag === "FrontmatterParseError" || error._tag === "ValidationError"
                ? "invalid_candidate"
                : "write_unavailable");
        if (reason === "exact_duplicate") {
          yield* controls.persist(
            append(
              controls.get(),
              controls.event({
                result: "rejected",
                reason,
                source: sourceRef(source, state.project),
              }),
            ),
          );
          return { status: "rejected", reason: "duplicate" } as const;
        }
        return yield* pending(reason);
      }
      if (intent && write.success.status === "published") {
        yield* controls.persist({
          ...controls.get(),
          audit: [
            ...controls.get().audit.slice(0, -1),
            { ...intent, result: "recorded", reason: "recorded" },
          ],
        });
        return { status: "recorded", canonicalId: write.success.id } as const;
      }
      return yield* pending("write_unavailable");
    }),
  ).pipe(
    Effect.catchCause(() =>
      Effect.succeed({ status: "pending", reason: "controls_unavailable" } as const),
    ),
  );
