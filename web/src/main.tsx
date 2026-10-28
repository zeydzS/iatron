import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import bundledLibrary from "./data/library.json";
import { mediaSources } from "./data/media";

const library = bundledLibrary as unknown as { catalog: Catalog; flows: Record<string, Flow> };

type Age = "infant" | "child" | "adolescent" | "adult";
type MenuItem = { id: string; label: string; procedure_id: string; entry_node_id: string | null };
type ProcedureRecord = { id: string; title: string; age_group: Age; path: string };
type Catalog = { age_groups: Record<Age, MenuItem[]>; procedures: Record<string, ProcedureRecord> };
type Media = {
  url?: string;
  asset_id?: string;
  placement_id?: string;
  source_image_shape_id?: string;
  association_status?: string;
};
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
  unassigned_media?: Media[];
  pages: Array<{ entry_node_id: string | null; nodes: FlowNode[] }>;
};
type HistoryEntry = { nodeId: string; selected: string[]; nextNodeId: string | null };
type Screen = "home" | "procedure" | "complete";

const ageGroupOptions: Array<{ id: Age; label: string; range: string }> = [
  { id: "infant", label: "Infant", range: "Under 1 year" },
  { id: "child", label: "Child", range: "1–12 years" },
  { id: "adolescent", label: "Adolescent", range: "13–17 years" },
  { id: "adult", label: "Adult", range: "18 years and older" },
];

function englishLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => {
      const cyrillicIndex = line.search(/[А-Яа-яЁё]/u);
      if (cyrillicIndex < 0) return line.trim();
      const translationStartIndex = line.lastIndexOf(" (", cyrillicIndex);
      return line
        .slice(0, translationStartIndex >= 0 ? translationStartIndex : cyrillicIndex)
        .trim();
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

function estimateRemaining(start: string | null, nodeById: Map<string, FlowNode>): number {
  function visit(id: string | null, seen: Set<string>, depth: number): number {
    if (!id || !nodeById.has(id) || depth >= 40 || seen.has(id)) return 0;
    const node = nodeById.get(id)!;
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

export function FindChoice(node: FlowNode, selectedOptionIds: string[]): string | null | undefined {
  if (!node.input) return node.next;
  const chosen = node.input.options.filter((option) => selectedOptionIds.includes(option.id));
  const resultCodeKey = [...new Set(chosen.flatMap((option) => option.result_codes ?? []))]
    .sort()
    .join("");
  const combinedNextNodeId = node.input.combination_routes?.[resultCodeKey];
  if (combinedNextNodeId) return combinedNextNodeId;
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
  const [procedureCatalog, setProcedureCatalog] = useState<Catalog | null>(null);
  const [activeScreen, setActiveScreen] = useState<Screen>("home");
  const [selectedAge, setSelectedAge] = useState<Age>("adult");
  const [searchQuery, setSearchQuery] = useState("");
  const [procedureFlow, setProcedureFlow] = useState<Flow | null>(null);
  const [pathHistory, setPathHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [routingNotice, setRoutingNotice] = useState("");
  const [offlineStatusMessage, setOfflineStatusMessage] = useState("");

  useEffect(() => {
    setProcedureCatalog(library.catalog);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    if (!import.meta.env.PROD) return;
    if (!("serviceWorker" in navigator)) {
      setOfflineStatusMessage("Offline storage is unavailable in this browser.");
      return;
    }
    let active = true;
    setOfflineStatusMessage("Saving for offline use...");
    const failed = () => {
      if (active) setOfflineStatusMessage("Offline setup failed. Reconnect and reload to retry.");
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
        if (active) setOfflineStatusMessage("Ready for offline use");
      })
      .catch(failed);
    return () => {
      active = false;
    };
  }, []);

  const nodeById = useMemo(() => {
    const result = new Map<string, FlowNode>();
    procedureFlow?.pages.forEach((page) => page.nodes.forEach((node) => result.set(node.id, node)));
    return result;
  }, [procedureFlow]);
  const currentHistoryEntry = pathHistory[historyIndex];
  const activeNode = currentHistoryEntry
    ? (nodeById.get(currentHistoryEntry.nodeId) ?? null)
    : null;
  const selectedOptionIds = currentHistoryEntry?.selected ?? [];
  const ageProcedures = procedureCatalog?.age_groups[selectedAge] ?? [];
  const filteredProcedures = ageProcedures.filter((item) =>
    english(item.label).toLowerCase().includes(searchQuery.trim().toLowerCase()),
  );
  const remainingStepCount = activeNode ? estimateRemaining(activeNode.id, nodeById) : 0;
  const progressPercent =
    activeScreen === "complete"
      ? 100
      : Math.max(
          5,
          Math.round(((historyIndex + 1) / Math.max(historyIndex + remainingStepCount, 1)) * 100),
        );

  async function begin(item: MenuItem) {
    if (!procedureCatalog) return;
    const procedureRecord = procedureCatalog.procedures[item.procedure_id];
    if (!procedureRecord) return setLoadError("This procedure is not available.");
    setIsLoading(true);
    setLoadError("");
    try {
      const loaded = Object.hasOwn(library.flows, procedureRecord.path)
        ? library.flows[procedureRecord.path]
        : undefined;
      if (!loaded) throw new Error("The selected procedure is not included in this app.");
      const start = item.entry_node_id ?? loaded.pages[0]?.entry_node_id;
      if (!start) throw new Error("This procedure has no starting step.");
      setProcedureFlow(loaded);
      setPathHistory([{ nodeId: start, selected: [], nextNodeId: null }]);
      setHistoryIndex(0);
      setActiveScreen("procedure");
      setIsReviewOpen(false);
      setRoutingNotice("");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : "The procedure could not be loaded.");
    } finally {
      setIsLoading(false);
    }
  }

  function EnterSelection(option: ChoiceOption) {
    if (!activeNode?.input) return;
    setRoutingNotice("");
    let nextSelectedOptionIds: string[];
    if (activeNode.input.selection_mode === "single") nextSelectedOptionIds = [option.id];
    else if (selectedOptionIds.includes(option.id))
      nextSelectedOptionIds = selectedOptionIds.filter((id) => id !== option.id);
    else if (option.exclusive) nextSelectedOptionIds = [option.id];
    else {
      const exclusiveOptionIds = new Set(
        activeNode.input.options.filter((item) => item.exclusive).map((item) => item.id),
      );
      nextSelectedOptionIds = [
        ...selectedOptionIds.filter((id) => !exclusiveOptionIds.has(id)),
        option.id,
      ];
    }
    setPathHistory((previousHistory) =>
      previousHistory.map((item, index) =>
        index === historyIndex ? { ...item, selected: nextSelectedOptionIds } : item,
      ),
    );
  }

  function continueProcedure() {
    if (!activeNode) return;
    const nextNodeId = FindChoice(activeNode, selectedOptionIds);
    if (nextNodeId === undefined) {
      setRoutingNotice(
        "This combination does not have one source-defined next step. Adjust the selection to continue.",
      );
      return;
    }
    if (!nextNodeId || !nodeById.has(nextNodeId)) {
      setActiveScreen("complete");
      setIsReviewOpen(false);
      return;
    }
    const existingHistoryEntry = pathHistory[historyIndex];
    if (
      existingHistoryEntry.nextNodeId === nextNodeId &&
      pathHistory[historyIndex + 1]?.nodeId === nextNodeId
    ) {
      setHistoryIndex(historyIndex + 1);
      setRoutingNotice("");
      return;
    }
    const updatedHistory = pathHistory.slice(0, historyIndex + 1);
    updatedHistory[historyIndex] = { ...updatedHistory[historyIndex], nextNodeId: nextNodeId };
    updatedHistory.push({ nodeId: nextNodeId, selected: [], nextNodeId: null });
    setPathHistory(updatedHistory);
    setHistoryIndex(historyIndex + 1);
    setRoutingNotice("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function restart() {
    if (!pathHistory.length) return;
    setPathHistory([{ nodeId: pathHistory[0].nodeId, selected: [], nextNodeId: null }]);
    setHistoryIndex(0);
    setActiveScreen("procedure");
    setIsReviewOpen(false);
    setRoutingNotice("");
  }
  function exitProcedure() {
    setActiveScreen("home");
    setProcedureFlow(null);
    setPathHistory([]);
    setHistoryIndex(0);
    setIsReviewOpen(false);
    setRoutingNotice("");
  }

  const canAdvance = Boolean(activeNode && (!activeNode.input || selectedOptionIds.length));
  const activeStepMedia = uniqueMedia(activeNode?.media ?? []);

  return (
    <main id="app-shell">
      <header id="app-header">
        <button id="brand" onClick={exitProcedure} aria-label="Iatron home">
          <span>+</span>
          <strong>Iatron</strong>
        </button>
        {procedureFlow && (
          <div id="header-actions">
            <button id="review-path" onClick={() => setIsReviewOpen(true)}>
              Review path
            </button>
            <button id="restart-path" onClick={restart}>
              Restart
            </button>
          </div>
        )}
      </header>

      {isLoading && <div id="loading-state">Loading…</div>}
      {loadError && (
        <div id="error-state">
          <h1>Unable to open the pathway</h1>
          <p>{loadError}</p>
          <button id="retry-pathway" onClick={() => location.reload()}>
            Try again
          </button>
        </div>
      )}

      {!isLoading && !loadError && activeScreen === "home" && (
        <section id="home">
          <div id="home-intro">
            <p id="home-eyebrow">Guided first-aid procedures</p>
            <h1>Choose the situation you want to follow</h1>
            <p>Each pathway takes you through the complete source procedure one step at a time.</p>
            {offlineStatusMessage && (
              <p id="offline-status" role="status">
                {offlineStatusMessage}
              </p>
            )}
          </div>
          <div id="age-tabs" aria-label="Age group">
            {ageGroupOptions.map((item) => (
              <button
                id={`age-${item.id}`}
                aria-pressed={selectedAge === item.id}
                onClick={() => {
                  setSelectedAge(item.id);
                  setSearchQuery("");
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
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search procedures"
            />
          </label>
          <div id="procedure-heading">
            <h2>{ageGroupOptions.find((item) => item.id === selectedAge)?.label} procedures</h2>
            <span>{filteredProcedures.length}</span>
          </div>
          <div id="procedure-list">
            {filteredProcedures.map((item) => (
              <button id={`procedure-${item.id}`} onClick={() => void begin(item)} key={item.id}>
                <span>{english(item.label)}</span>
                <b aria-hidden="true">→</b>
              </button>
            ))}
          </div>
        </section>
      )}

      {!isLoading &&
        !loadError &&
        (activeScreen === "procedure" || activeScreen === "complete") &&
        procedureFlow && (
          <section id="pathway">
            <div id="procedure-title">
              <button onClick={exitProcedure}>← All procedures</button>
              <p>{english(procedureFlow.title)}</p>
            </div>
            <div id="progress-meta">
              <span>
                {activeScreen === "complete" ? "Procedure complete" : `Step ${historyIndex + 1}`}
              </span>
              <span>{progressPercent}%</span>
            </div>
            <div id="progress-track">
              <span style={{ width: `${progressPercent}%` }} />
            </div>

            {activeScreen === "procedure" && activeNode && (
              <article
                id="step-card"
                data-urgent={activeNode.role === "emergency_instruction" || undefined}
              >
                <div id="step-content">
                  <p id="step-eyebrow">
                    {activeNode.input ? "Choose an answer" : "Follow this step"}
                  </p>
                  {activeNode.input ? (
                    <h1>{english(activeNode.input.prompt || activeNode.text)}</h1>
                  ) : (
                    <TextContent text={activeNode.text} />
                  )}
                  {activeNode.input && (
                    <div
                      id="options"
                      role={activeNode.input.selection_mode === "single" ? "radiogroup" : "group"}
                    >
                      {activeNode.input.options.map((option) => {
                        const active = selectedOptionIds.includes(option.id);
                        return (
                          <button
                            id={`option-${activeNode.id}-${option.id}`}
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
                  {routingNotice && (
                    <p id="route-message" role="alert">
                      {routingNotice}
                    </p>
                  )}
                </div>
                {activeStepMedia.length > 0 && (
                  <div id="step-media">
                    {activeStepMedia.map((item) => (
                      <img
                        src={item.url ? mediaSources[item.url] : undefined}
                        alt="First-aid step illustration"
                        key={item.asset_id ?? item.url}
                      />
                    ))}
                    {activeStepMedia.some(
                      (item) => item.association_status === "inferred_unique_adjacent",
                    ) && (
                      <small>
                        Original Visio illustration. Placement is inferred from the source layout.
                      </small>
                    )}
                  </div>
                )}
              </article>
            )}

            {activeScreen === "complete" && (
              <article id="completion-card">
                <span id="completion-mark">✓</span>
                <p id="completion-eyebrow">End of procedure</p>
                <h1>{english(procedureFlow.title)}</h1>
                <p>
                  You have reached the end of this pathway. You can review every step and answer you
                  followed.
                </p>
                <div id="completion-actions">
                  <button id="completion-review" onClick={() => setIsReviewOpen(true)}>
                    Review followed path
                  </button>
                  <button id="restart-procedure" onClick={restart}>
                    Restart procedure
                  </button>
                </div>
              </article>
            )}

            {activeScreen === "procedure" && (
              <footer id="path-controls">
                <button
                  id="previous-step"
                  disabled={historyIndex === 0}
                  onClick={() => {
                    setHistoryIndex(Math.max(0, historyIndex - 1));
                    setRoutingNotice("");
                  }}
                >
                  ← Back
                </button>
                <button id="continue-step" disabled={!canAdvance} onClick={continueProcedure}>
                  Continue →
                </button>
              </footer>
            )}
          </section>
        )}

      {isReviewOpen && (
        <div id="drawer-backdrop" onClick={() => setIsReviewOpen(false)}>
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
              <button onClick={() => setIsReviewOpen(false)} aria-label="Close">
                ×
              </button>
            </div>
            <div id="history-list">
              {pathHistory.map((item, index) => {
                const node = nodeById.get(item.nodeId);
                if (!node) return null;
                const selectedAnswerLabels =
                  node.input?.options
                    .filter((option) => item.selected.includes(option.id))
                    .map((option) => english(option.label)) ?? [];
                return (
                  <button
                    id={`history-${item.nodeId}-${index}`}
                    aria-current={
                      index === historyIndex && activeScreen === "procedure" ? "step" : undefined
                    }
                    onClick={() => {
                      setHistoryIndex(index);
                      setActiveScreen("procedure");
                      setIsReviewOpen(false);
                    }}
                    key={`${item.nodeId}-${index}`}
                  >
                    <span>{index + 1}</span>
                    <div>
                      <strong>{english(node.input?.prompt || node.text)}</strong>
                      {selectedAnswerLabels.length > 0 && (
                        <small>{selectedAnswerLabels.join(", ")}</small>
                      )}
                    </div>
                    <b>↩</b>
                  </button>
                );
              })}
            </div>
            {!!procedureFlow?.unassigned_media?.length && (
              <section id="source-image-review">
                <h3>Original images awaiting placement</h3>
                <p>These images belong to this procedure. Their matching step is unresolved.</p>
                {procedureFlow.unassigned_media.map((item) => (
                  <figure key={item.placement_id ?? item.url}>
                    <img
                      src={item.url ? mediaSources[item.url] : undefined}
                      alt="Unplaced original source illustration"
                    />
                    <figcaption>Source image {item.source_image_shape_id}</figcaption>
                  </figure>
                ))}
              </section>
            )}
            <button id="close-review" onClick={() => setIsReviewOpen(false)}>
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
