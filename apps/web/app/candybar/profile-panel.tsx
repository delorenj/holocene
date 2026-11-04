"use client";

import { CopyRef } from "../hub/ui";
import { ACTION_LABEL, followUpLabel, taskOutcomeLabel, taskSpend } from "./candybar-model";
import { OutcomeChip } from "./row-parts";
import type { AxisName, Evaluation, Overview, Profile, RowTasks, Task, TaskAction } from "./types";

// What the steward wrote down about a candybar (overview, evaluation) and what it is doing or did (tasks).

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const STAMP = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const day = (iso?: string | null) => (iso && Number.isFinite(Date.parse(iso)) ? DAY.format(Date.parse(iso)) : undefined);
const stamp = (iso?: string | null) => (iso && Number.isFinite(Date.parse(iso)) ? STAMP.format(Date.parse(iso)) : undefined);

function List({ title, items, ordered }: { title: string; items: string[]; ordered?: boolean }) {
  if (!items.length) return null;
  const Tag = ordered ? "ol" : "ul";
  return (
    <div className="cb-ov-block">
      <h4 className="cb-ov-h">{title}</h4>
      <Tag className={`cb-ov-list${ordered ? " is-ordered" : ""}`}>
        {items.map((x, i) => <li key={`${i}-${x}`}>{x}</li>)}
      </Tag>
    </div>
  );
}

function OverviewView({ o, profile }: { o: Overview; profile: Profile }) {
  const enriched = day(profile.enrichedAt);
  return (
    <section className="cb-ov" aria-label="Overview">
      {o.summary ? <p className="cb-ov-lead">{o.summary}</p> : null}
      <div className="cb-ov-grid">
        {o.purpose ? <div className="cb-ov-block is-wide"><h4 className="cb-ov-h">Purpose</h4><p className="cb-ov-p">{o.purpose}</p></div> : null}
        <List title="Behavior" items={o.behavior} ordered />
        <List title="Inputs" items={o.inputs} />
        <List title="Outputs" items={o.outputs} />
        <List title="Side effects" items={o.sideEffects} />
        <List title="Dependencies" items={o.dependencies} />
        <List title="Failure modes" items={o.failureModes} />
        <List title="Verification" items={o.verification} />
        {o.runbook.length ? (
          <div className="cb-ov-block is-wide">
            <h4 className="cb-ov-h">Runbook</h4>
            <div className="cb-ov-refs">{o.runbook.map((cmd, i) => <CopyRef key={`${i}-${cmd}`} value={cmd} />)}</div>
          </div>
        ) : null}
        {o.source.repo || o.source.paths.length || o.source.runner ? (
          <div className="cb-ov-block is-wide">
            <h4 className="cb-ov-h">Source</h4>
            <p className="cb-ov-p">
              {o.source.runner ? <span className="cb-chip">{o.source.runner}</span> : null}
              {o.source.repo ? <> <code>{o.source.repo}</code></> : null}
              {o.source.paths.map((p) => <span key={p}> <code>{p}</code></span>)}
            </p>
          </div>
        ) : null}
        {o.cadenceNote ? <div className="cb-ov-block is-wide"><h4 className="cb-ov-h">Cadence</h4><p className="cb-ov-p">{o.cadenceNote}</p></div> : null}
      </div>
      <p className="cb-ov-foot">
        {enriched ? `Enriched ${enriched}` : "Enriched"}
        {profile.templateVersion !== null ? ` · template v${profile.templateVersion}` : ""}
      </p>
    </section>
  );
}

const AXES: AxisName[] = ["efficacy", "cost", "value", "usage", "alternatives"];
const RATING_WORD = { good: "Good", fair: "Fair", poor: "Poor" } as const;

function EvaluationView({ e, tasks }: { e: Evaluation; tasks: RowTasks | undefined }) {
  const evaluated = stamp(e.evaluatedAt);
  const child = e.followUp === "refactor" || e.followUp === "fix" ? tasks?.latest[e.followUp] : undefined;
  const followUp = followUpLabel(e, child);
  return (
    <section className="cb-eval" aria-label="Evaluation">
      <h3 className="cb-sub-h">
        Evaluation <OutcomeChip outcome={e.outcome} />
        {evaluated ? <span className="cb-sub-note">{evaluated}</span> : null}
      </h3>
      {e.summary ? <p className="cb-ov-p">{e.summary}</p> : null}
      <dl className="cb-axes">
        {AXES.filter((a) => e.axes[a]).map((a) => (
          <div key={a} className="cb-axis">
            <dt>{a}</dt>
            <dd>
              <span className={`cb-rating is-${e.axes[a]!.rating}`}>{RATING_WORD[e.axes[a]!.rating]}</span>
              {e.axes[a]!.finding ? <span className="cb-axis-finding">{e.axes[a]!.finding}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      {e.recommendation ? <p className="cb-ov-p"><span className="cb-inline-h">Recommendation</span> {e.recommendation}</p> : null}
      <p className="cb-eval-foot">
        <span className={`cb-follow-up${e.followUpStatus === "flagged" ? " is-flagged" : ""}`}><span className="cb-inline-h">Follow-up</span> {followUp}</span>
        {e.reportKey ? <CopyRef value={e.reportKey} label={`report ${e.reportKey.split("/").pop()}`} /> : null}
      </p>
    </section>
  );
}

export function ProfileView({ profile, tasks }: { profile: Profile | null | undefined; tasks?: RowTasks }) {
  if (profile === undefined) {
    return <p className="cb-empty-note">Profiles could not be read from Candybar, so there is no overview to show.</p>;
  }
  return (
    <>
      {profile?.overview ? (
        <OverviewView o={profile.overview} profile={profile} />
      ) : (
        <p className="cb-empty-note">No overview yet. Press <strong>Enrich</strong> and the steward will read this candybar&rsquo;s source and write one.</p>
      )}
      {profile?.evaluation ? <EvaluationView e={profile.evaluation} tasks={tasks} /> : null}
    </>
  );
}

const STATUS_WORD: Record<Task["status"], string> = { queued: "queued", running: "running", succeeded: "succeeded", failed: "failed" };
const ORDER: TaskAction[] = ["enrich", "evaluate", "fix", "refactor"];

export function TasksView({ tasks }: { tasks: RowTasks | undefined }) {
  const latest = ORDER.map((a) => tasks?.latest[a]).filter((t): t is Task => t !== undefined);
  if (!latest.length) return null;
  return (
    <section className="cb-tasks" aria-label="Steward tasks">
      <h3 className="cb-sub-h">Steward</h3>
      <ul className="cb-task-list">
        {latest.map((t) => (
          <li key={t.id} className="cb-task">
            <span className="cb-task-head">
              <span className="cb-task-action">{ACTION_LABEL[t.action]}</span>
              <span className={`cb-task-status is-${t.status}`}>{STATUS_WORD[t.status]}</span>
              {t.outcome ? <span className="cb-task-outcome">{taskOutcomeLabel(t.outcome)}</span> : null}
              {t.parentTaskId ? <span className="cb-task-when">follow-up of an evaluation</span> : null}
              <span className="cb-task-when">{stamp(t.finishedAt ?? t.startedAt ?? t.createdAt)}</span>
              {taskSpend(t) ? <span className="cb-task-when">{taskSpend(t)}</span> : null}
            </span>
            {t.summary ? <span className="cb-task-summary">{t.summary}</span> : null}
            {t.error ? <span className="cb-task-error">{t.error}</span> : null}
            {t.sessionId ? <span className="cb-task-ref"><CopyRef value={t.sessionId} label={`session ${t.sessionId}`} /></span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
