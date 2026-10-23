import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import bundledLibrary from "../../../mobile/src/data/library.json";
import { mediaSources } from "./data/media";

const library = bundledLibrary as unknown as { catalog: Catalog; flows: Record<string, Flow> };

type Age = "infant" | "child" | "adolescent" | "adult";
type MenuItem = { id: string; label: string; procedure_id: string; entry_node_id: string | null };
type ProcedureRecord = { id: string; title: string; age_group: Age; path: string };
type Catalog = { age_groups: Record<Age, MenuItem[]>; procedures: Record<string, ProcedureRecord> };
type Media = { url?: string; asset_id?: string };
type ChoiceOption = {
  id: string;
  label: string;
  exclusive?: boolean;
  go_to?: string | null;
  result_codes?: string[];
};
type ChoiceInput = {
  kind: "choice";
  selection_mode: "single" | "multiple";
  prompt?: string;
  options: ChoiceOption[];
  combination_routes?: Record<string, string>;
};
type FlowNode = {
  id: string;
  role: string;
  text: string;
  media: Media[];
  next: string | null;
  input: ChoiceInput | null;
};
type Flow = {
  document_id: string;
  title: string;
  age_group: Age;
  pages: Array<{ entry_node_id: string | null; nodes: FlowNode[] }>;
};
type HistoryEntry = { nodeId: string; selected: string[]; nextNodeId: string | null };
type Screen = "home" | "procedure" | "complete";

const ageGroups: Array<{ id: Age; label: string; range: string }> = [
  { id: "infant", label: "Infant", range: "Under 1 year" },
  { id: "child", label: "Child", range: "1–12 years" },
  { id: "adolescent", label: "Adolescent", range: "13–17 years" },
  { id: "adult", label: "Adult", range: "18 years and older" },
];

function englishLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => {
      const cyrillic = line.search(/[А-Яа-яЁё]/u);
      if (cyrillic < 0) return line.trim();
      const parenthetical = line.lastIndexOf(" (", cyrillic);
      return line.slice(0, parenthetical >= 0 ? parenthetical : cyrillic).trim();
    })
    .filter(Boolean);
}

function english(value: string): string {
  return englishLines(value).join(" ").trim();
}
function uniqueMedia(media: Media[]): Media[] {
  return media.filter(
    (item, index) => item.url && media.findIndex((other) => other.url === item.url) === index,
  );
}

function estimateRemaining(start: string | null, nodes: Map<string, FlowNode>): number {
  function visit(id: string | null, seen: Set<string>, depth: number): number {
    if (!id || !nodes.has(id) || depth >= 40 || seen.has(id)) return 0;
    const node = nodes.get(id)!;
    const nextSeen = new Set(seen).add(id);
    const targets = [
      node.next,
      ...(node.input?.options.map((option) => option.go_to ?? null) ?? []),
      ...Object.values(node.input?.combination_routes ?? {}),
    ].filter(
      (target, index, all): target is string => Boolean(target) && all.indexOf(target) === index,
    );
    return (
      1 +
      (targets.length
        ? Math.max(...targets.map((target) => visit(target, nextSeen, depth + 1)))
        : 0)
    );
  }
  return visit(start, new Set(), 0);
}

function TextContent({ text }: { text: string }) {
  const lines = englishLines(text);
  return (
    <div id="source-copy">
      {lines.map((line, index) => {
        const bullet = /^([•·▪◦]|\d+[.)])\s*/u.test(line);
        return (
          <p id={`${bullet ? "source-bullet" : "source-line"}-${index}`} key={`${line}-${index}`}>
            {line}
          </p>
        );
      })}
    </div>
  );
}

export function FindChoice(node: FlowNode, selected: string[]): string | null | undefined {
  if (!node.input) return node.next;
  const chosen = node.input.options.filter((option) => selected.includes(option.id));
  const codes = [...new Set(chosen.flatMap((option) => option.result_codes ?? []))].sort().join("");
  const combined = node.input.combination_routes?.[codes];
  if (combined) return combined;
  const targets = [
    ...new Set(
      chosen.map((option) => option.go_to).filter((value): value is string => Boolean(value)),
    ),
  ];
  if (targets.length === 1) return targets[0];
  if (targets.length > 1) return undefined;
  return node.next ?? undefined;
}

function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  const [age, setAge] = useState<Age>("adult");
  const [query, setQuery] = useState("");
  const [flow, setFlow] = useState<Flow | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [cursor, setCursor] = useState(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [routeMessage, setRouteMessage] = useState("");
  const [offlineStatus, setOfflineStatus] = useState("");

  useEffect(() => {
    setCatalog(library.catalog);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!import.meta.env.PROD) return;
    if (!("serviceWorker" in navigator)) {
      setOfflineStatus("Offline storage is unavailable in this browser.");
      return;
    }
    let active = true;
    setOfflineStatus("Saving for offline use...");
    const failed = () => {
      if (active) setOfflineStatus("Offline setup failed. Reconnect and reload to retry.");
    };
    navigator.serviceWorker
      .register(import.meta.env.BASE_URL + "sw.js")
      .then((registration) => {
        const worker = registration.installing;
        if (worker) {
          worker.addEventListener("statechange", () => {
            if (worker.state === "redundant") failed();
          });
          if (worker.state === "redundant") failed();
        }
        return navigator.serviceWorker.ready;
      })
      .then(() => {
        if (active) setOfflineStatus("Ready for offline use");
      })
      .catch(failed);
    return () => {
      active = false;
    };
  }, []);

  const nodes = useMemo(() => {
    const result = new Map<string, FlowNode>();
    flow?.pages.forEach((page) => page.nodes.forEach((node) => result.set(node.id, node)));
    return result;
  }, [flow]);
  const entry = history[cursor];
  const current = entry ? (nodes.get(entry.nodeId) ?? null) : null;
  const selected = entry?.selected ?? [];
  const procedures = catalog?.age_groups[age] ?? [];
  const visibleProcedures = procedures.filter((item) =>
    english(item.label).toLowerCase().includes(query.trim().toLowerCase()),
  );
  const remaining = current ? estimateRemaining(current.id, nodes) : 0;
  const progress =
    screen === "complete"
      ? 100
      : Math.max(5, Math.round(((cursor + 1) / Math.max(cursor + remaining, 1)) * 100));

  async function begin(item: MenuItem) {
    if (!catalog) return;
    const record = catalog.procedures[item.procedure_id];
    if (!record) return setError("This procedure is not available.");
    setLoading(true);
    setError("");
    try {
      const loaded = Object.hasOwn(library.flows, record.path)
        ? library.flows[record.path]
        : undefined;
      if (!loaded) throw new Error("The selected procedure is not included in this app.");
      const start = item.entry_node_id ?? loaded.pages[0]?.entry_node_id;
      if (!start) throw new Error("This procedure has no starting step.");
      setFlow(loaded);
      setHistory([{ nodeId: start, selected: [], nextNodeId: null }]);
      setCursor(0);
      setScreen("procedure");
      setReviewOpen(false);
      setRouteMessage("");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The procedure could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  function EnterSelection(option: ChoiceOption) {
    if (!current?.input) return;
    setRouteMessage("");
    let nextSelected: string[];
    if (current.input.selection_mode === "single") nextSelected = [option.id];
    else if (selected.includes(option.id)) nextSelected = selected.filter((id) => id !== option.id);
    else if (option.exclusive) nextSelected = [option.id];
    else {
      const exclusiveIds = new Set(
        current.input.options.filter((item) => item.exclusive).map((item) => item.id),
      );
      nextSelected = [...selected.filter((id) => !exclusiveIds.has(id)), option.id];
    }
    setHistory((old) =>
      old.map((item, index) => (index === cursor ? { ...item, selected: nextSelected } : item)),
    );
  }

  function continueProcedure() {
    if (!current) return;
    const next = FindChoice(current, selected);
    if (next === undefined) {
      setRouteMessage(
        "This combination does not have one source-defined next step. Adjust the selection to continue.",
      );
      return;
    }
    if (!next || !nodes.has(next)) {
      setScreen("complete");
      setReviewOpen(false);
      return;
    }
    const existing = history[cursor];
    if (existing.nextNodeId === next && history[cursor + 1]?.nodeId === next) {
      setCursor(cursor + 1);
      setRouteMessage("");
      return;
    }
    const updated = history.slice(0, cursor + 1);
    updated[cursor] = { ...updated[cursor], nextNodeId: next };
    updated.push({ nodeId: next, selected: [], nextNodeId: null });
    setHistory(updated);
    setCursor(cursor + 1);
    setRouteMessage("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function restart() {
    if (!history.length) return;
    setHistory([{ nodeId: history[0].nodeId, selected: [], nextNodeId: null }]);
    setCursor(0);
    setScreen("procedure");
    setReviewOpen(false);
    setRouteMessage("");
  }
  function exitProcedure() {
    setScreen("home");
    setFlow(null);
    setHistory([]);
    setCursor(0);
    setReviewOpen(false);
    setRouteMessage("");
  }

  const canContinue = Boolean(current && (!current.input || selected.length));
  const currentMedia = uniqueMedia(current?.media ?? []);

  return (
    <main id="app-shell">
      <header id="app-header">
        <button id="brand" onClick={exitProcedure} aria-label="Iatron home">
          <span>+</span>
          <strong>Iatron</strong>
        </button>
        {flow && (
          <div id="header-actions">
            <button id="review-path" onClick={() => setReviewOpen(true)}>
              Review path
            </button>
            <button id="restart-path" onClick={restart}>
              Restart
            </button>
          </div>
        )}
      </header>

      {loading && <div id="loading-state">Loading…</div>}
      {error && (
        <div id="error-state">
          <h1>Unable to open the pathway</h1>
          <p>{error}</p>
          <button id="retry-pathway" onClick={() => location.reload()}>
            Try again
          </button>
        </div>
      )}

      {!loading && !error && screen === "home" && (
        <section id="home">
          <div id="home-intro">
            <p id="home-eyebrow">Guided first-aid procedures</p>
            <h1>Choose the situation you want to follow</h1>
            <p>Each pathway takes you through the complete source procedure one step at a time.</p>
            {offlineStatus && (
              <p id="offline-status" role="status">
                {offlineStatus}
              </p>
            )}
          </div>
          <div id="age-tabs" aria-label="Age group">
            {ageGroups.map((item) => (
              <button
                id={`age-${item.id}`}
                aria-pressed={age === item.id}
                onClick={() => {
                  setAge(item.id);
                  setQuery("");
                }}
                key={item.id}
              >
                <strong>{item.label}</strong>
                <span>{item.range}</span>
              </button>
            ))}
          </div>
          <label id="search">
            <span aria-hidden="true">⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search procedures"
            />
          </label>
          <div id="procedure-heading">
            <h2>{ageGroups.find((item) => item.id === age)?.label} procedures</h2>
            <span>{visibleProcedures.length}</span>
          </div>
          <div id="procedure-list">
            {visibleProcedures.map((item) => (
              <button id={`procedure-${item.id}`} onClick={() => void begin(item)} key={item.id}>
                <span>{english(item.label)}</span>
                <b aria-hidden="true">→</b>
              </button>
            ))}
          </div>
        </section>
      )}

      {!loading && !error && (screen === "procedure" || screen === "complete") && flow && (
        <section id="pathway">
          <div id="procedure-title">
            <button onClick={exitProcedure}>← All procedures</button>
            <p>{english(flow.title)}</p>
          </div>
          <div id="progress-meta">
            <span>{screen === "complete" ? "Procedure complete" : `Step ${cursor + 1}`}</span>
            <span>{progress}%</span>
          </div>
          <div id="progress-track">
            <span style={{ width: `${progress}%` }} />
          </div>

          {screen === "procedure" && current && (
            <article
              id="step-card"
              data-urgent={current.role === "emergency_instruction" || undefined}
            >
              <div id="step-content">
                <p id="step-eyebrow">{current.input ? "Choose an answer" : "Follow this step"}</p>
                {current.input ? (
                  <h1>{english(current.input.prompt || current.text)}</h1>
                ) : (
                  <TextContent text={current.text} />
                )}
                {current.input && (
                  <div
                    id="options"
                    role={current.input.selection_mode === "single" ? "radiogroup" : "group"}
                  >
                    {current.input.options.map((option) => {
                      const active = selected.includes(option.id);
                      return (
                        <button
                          id={`option-${current.id}-${option.id}`}
                          aria-pressed={active}
                          onClick={() => EnterSelection(option)}
                          key={option.id}
                        >
                          <i>{active ? "✓" : ""}</i>
                          <span>{english(option.label)}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {routeMessage && (
                  <p id="route-message" role="alert">
                    {routeMessage}
                  </p>
                )}
              </div>
              {currentMedia.length > 0 && (
                <div id="step-media">
                  {currentMedia.map((item) => (
                    <img
                      src={item.url ? mediaSources[item.url] : undefined}
                      alt="First-aid step illustration"
                      key={item.asset_id ?? item.url}
                    />
                  ))}
                </div>
              )}
            </article>
          )}

          {screen === "complete" && (
            <article id="completion-card">
              <span id="completion-mark">✓</span>
              <p id="completion-eyebrow">End of procedure</p>
              <h1>{english(flow.title)}</h1>
              <p>
                You have reached the end of this pathway. You can review every step and answer you
                followed.
              </p>
              <div id="completion-actions">
                <button id="completion-review" onClick={() => setReviewOpen(true)}>
                  Review followed path
                </button>
                <button id="restart-procedure" onClick={restart}>
                  Restart procedure
                </button>
              </div>
            </article>
          )}

          {screen === "procedure" && (
            <footer id="path-controls">
              <button
                id="previous-step"
                disabled={cursor === 0}
                onClick={() => {
                  setCursor(Math.max(0, cursor - 1));
                  setRouteMessage("");
                }}
              >
                ← Back
              </button>
              <button id="continue-step" disabled={!canContinue} onClick={continueProcedure}>
                Continue →
              </button>
            </footer>
          )}
        </section>
      )}

      {reviewOpen && (
        <div id="drawer-backdrop" onClick={() => setReviewOpen(false)}>
          <aside
            id="path-drawer"
            onClick={(event) => event.stopPropagation()}
            aria-label="Followed path"
          >
            <div id="drawer-header">
              <div>
                <p id="review-eyebrow">Your followed path</p>
                <h2>Procedure review</h2>
              </div>
              <button onClick={() => setReviewOpen(false)} aria-label="Close">
                ×
              </button>
            </div>
            <div id="history-list">
              {history.map((item, index) => {
                const node = nodes.get(item.nodeId);
                if (!node) return null;
                const answers =
                  node.input?.options
                    .filter((option) => item.selected.includes(option.id))
                    .map((option) => english(option.label)) ?? [];
                return (
                  <button
                    id={`history-${item.nodeId}-${index}`}
                    aria-current={index === cursor && screen === "procedure" ? "step" : undefined}
                    onClick={() => {
                      setCursor(index);
                      setScreen("procedure");
                      setReviewOpen(false);
                    }}
                    key={`${item.nodeId}-${index}`}
                  >
                    <span>{index + 1}</span>
                    <div>
                      <strong>{english(node.input?.prompt || node.text)}</strong>
                      {answers.length > 0 && <small>{answers.join(", ")}</small>}
                    </div>
                    <b>↩</b>
                  </button>
                );
              })}
            </div>
            <button id="close-review" onClick={() => setReviewOpen(false)}>
              Close review
            </button>
          </aside>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
