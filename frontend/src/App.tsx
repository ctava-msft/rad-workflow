import { FormEvent, useEffect, useState } from "react";
import {
  ChatBubbleLeftRightIcon,
  CheckCircleIcon,
  ClockIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import "./app.css";
import {
  AuthenticatedTemplate,
  UnauthenticatedTemplate,
} from "@azure/msal-react";
import appLogo from "./assets/app.png";
import LoginComponent from "./components/LoginComponent";
import UserProfile from "./components/UserProfile";
import {
  CasePriority,
  CaseReview,
  CaseStatus,
  CreateCaseInput,
  RadiologyCase,
  ReviewRecommendation,
  radiologyApi,
} from "./api";

const statuses: { value: "all" | CaseStatus; label: string }[] = [
  { value: "all", label: "All cases" },
  { value: "candidate", label: "Candidates" },
  { value: "selected", label: "Selected" },
  { value: "in-review", label: "In review" },
  { value: "consensus", label: "Consensus" },
  { value: "closed", label: "Closed" },
];

const initialDraft: CreateCaseInput = {
  accession_number: "",
  patient_reference: "",
  modality: "CT",
  body_part: "",
  clinical_question: "",
  priority: "routine",
  selection_reason: "",
};

function formatStatus(value: CaseStatus): string {
  return value.replace("-", " ");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function CaseForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (created: RadiologyCase) => void;
}) {
  const [draft, setDraft] = useState<CreateCaseInput>(initialDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      onCreated(await radiologyApi.createCase(draft));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create case.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="case-modal" role="dialog" aria-modal="true" aria-labelledby="new-case-title">
        <div className="modal-heading">
          <div>
            <span className="eyebrow">Case intake</span>
            <h2 id="new-case-title">Add a candidate</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close case form" title="Close">
            <XMarkIcon />
          </button>
        </div>
        <form className="case-form" onSubmit={submit}>
          <label>
            Accession number
            <input required value={draft.accession_number} onChange={(event) => setDraft({ ...draft, accession_number: event.target.value })} />
          </label>
          <label>
            Patient reference
            <input required value={draft.patient_reference} onChange={(event) => setDraft({ ...draft, patient_reference: event.target.value })} />
          </label>
          <label>
            Modality
            <select value={draft.modality} onChange={(event) => setDraft({ ...draft, modality: event.target.value })}>
              {['CT', 'MR', 'XR', 'US', 'MG', 'PET', 'NM', 'OTHER'].map((modality) => <option key={modality}>{modality}</option>)}
            </select>
          </label>
          <label>
            Body part
            <input required value={draft.body_part} onChange={(event) => setDraft({ ...draft, body_part: event.target.value })} />
          </label>
          <label>
            Priority
            <select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value as CasePriority })}>
              <option value="routine">Routine</option>
              <option value="urgent">Urgent</option>
              <option value="stat">Stat</option>
            </select>
          </label>
          <label className="wide-field">
            Clinical question
            <textarea required rows={3} value={draft.clinical_question} onChange={(event) => setDraft({ ...draft, clinical_question: event.target.value })} />
          </label>
          <label className="wide-field">
            Why should the team review this case?
            <textarea rows={3} value={draft.selection_reason} onChange={(event) => setDraft({ ...draft, selection_reason: event.target.value })} />
          </label>
          {error && <p className="form-error">{error}</p>}
          <div className="form-actions wide-field">
            <button className="button secondary" type="button" onClick={onClose}>Cancel</button>
            <button className="button primary" type="submit" disabled={saving}>
              <PlusIcon /> {saving ? "Adding..." : "Add candidate"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function CaseDetail({
  selectedCase,
  reviews,
  onUpdate,
  onReview,
  onClose,
}: {
  selectedCase: RadiologyCase;
  reviews: CaseReview[];
  onUpdate: (changes: Partial<RadiologyCase>) => Promise<void>;
  onReview: (recommendation: ReviewRecommendation, comment: string) => Promise<void>;
  onClose: () => void;
}) {
  const [recommendation, setRecommendation] = useState<ReviewRecommendation>("discuss");
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);

  async function submitReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      await onReview(recommendation, comment);
      setComment("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside className="detail-panel" aria-label={`Case ${selectedCase.accession_number}`}>
      <div className="detail-heading">
        <div>
          <span className="eyebrow">{selectedCase.modality} / {selectedCase.body_part}</span>
          <h2>{selectedCase.accession_number}</h2>
          <p>{selectedCase.patient_reference}</p>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close case details" title="Close">
          <XMarkIcon />
        </button>
      </div>

      <div className="detail-controls">
        <label>
          Workflow status
          <select value={selectedCase.status} onChange={(event) => void onUpdate({ status: event.target.value as CaseStatus })}>
            {statuses.slice(1).map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
          </select>
        </label>
        <span className={`priority priority-${selectedCase.priority}`}>{selectedCase.priority}</span>
      </div>

      <section className="case-context">
        <h3>Clinical question</h3>
        <p>{selectedCase.clinical_question}</p>
        <h3>Selection rationale</h3>
        <p>{selectedCase.selection_reason || "No rationale added yet."}</p>
        <div className="case-audit">
          <ClockIcon /> Added {formatDate(selectedCase.created_at)} by {selectedCase.created_by}
        </div>
      </section>

      <section className="discussion">
        <div className="section-title">
          <div>
            <span className="eyebrow">Collaboration</span>
            <h3>Clinical discussion</h3>
          </div>
          <span className="count-badge">{reviews.length}</span>
        </div>
        <div className="review-list">
          {reviews.length === 0 && <p className="empty-copy">No review notes yet.</p>}
          {reviews.map((review) => (
            <article className="review" key={review.id}>
              <div className="review-meta">
                <strong>{review.author}</strong>
                <span className={`recommendation recommendation-${review.recommendation}`}>{review.recommendation}</span>
              </div>
              <p>{review.comment}</p>
              <time>{formatDate(review.created_at)}</time>
            </article>
          ))}
        </div>
        <form className="review-form" onSubmit={submitReview}>
          <div className="recommendation-switch" aria-label="Recommendation">
            {(["include", "discuss", "exclude"] as ReviewRecommendation[]).map((value) => (
              <button type="button" key={value} className={recommendation === value ? "active" : ""} onClick={() => setRecommendation(value)} aria-pressed={recommendation === value}>
                {value}
              </button>
            ))}
          </div>
          <textarea required rows={3} placeholder="Add evidence, context, or a question for the team" value={comment} onChange={(event) => setComment(event.target.value)} />
          <button className="button primary" type="submit" disabled={saving || !comment.trim()}>
            <ChatBubbleLeftRightIcon /> {saving ? "Posting..." : "Post note"}
          </button>
        </form>
      </section>
    </aside>
  );
}

function Workspace() {
  const [cases, setCases] = useState<RadiologyCase[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reviews, setReviews] = useState<CaseReview[]>([]);
  const [statusFilter, setStatusFilter] = useState<"all" | CaseStatus>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);

  const selectedCase = cases.find((item) => item.id === selectedId) ?? null;
  const normalizedSearch = search.trim().toLowerCase();
  const visibleCases = cases.filter((item) => {
    const matchesStatus = statusFilter === "all" || item.status === statusFilter;
    const searchable = `${item.accession_number} ${item.patient_reference} ${item.modality} ${item.body_part} ${item.clinical_question}`.toLowerCase();
    return matchesStatus && (!normalizedSearch || searchable.includes(normalizedSearch));
  });

  useEffect(() => {
    radiologyApi.listCases()
      .then((loaded) => {
        setCases(loaded);
        setSelectedId(loaded[0]?.id ?? null);
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Unable to load cases."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setReviews([]);
      return;
    }
    radiologyApi.listReviews(selectedId)
      .then(setReviews)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Unable to load discussion."));
  }, [selectedId]);

  async function updateSelected(changes: Partial<RadiologyCase>) {
    if (!selectedId) return;
    try {
      const updated = await radiologyApi.updateCase(selectedId, changes);
      setCases((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to update case.");
    }
  }

  async function addReview(recommendation: ReviewRecommendation, comment: string) {
    if (!selectedId) return;
    try {
      const created = await radiologyApi.createReview(selectedId, recommendation, comment);
      setReviews((current) => [...current, created]);
      setCases((current) => current.map((item) => item.id === selectedId ? { ...item, review_count: item.review_count + 1 } : item));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to post note.");
      throw caught;
    }
  }

  const selectedCount = cases.filter((item) => item.status === "selected" || item.status === "in-review").length;
  const urgentCount = cases.filter((item) => item.priority !== "routine" && item.status !== "closed").length;
  const consensusCount = cases.filter((item) => item.status === "consensus").length;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img src={appLogo} alt="" />
          <div><strong>Rad Review</strong><span>Case selection workspace</span></div>
        </div>
        <UserProfile />
      </header>

      <section className="workspace-heading">
        <div>
          <span className="eyebrow">Multidisciplinary review</span>
          <h1>Case selection</h1>
          <p>Shape the next review list with shared clinical context.</p>
        </div>
        <button className="button primary" type="button" onClick={() => setShowForm(true)}><PlusIcon /> Add case</button>
      </section>

      <section className="metrics" aria-label="Case summary">
        <div><span>Open queue</span><strong>{cases.filter((item) => item.status !== "closed").length}</strong></div>
        <div><span>Selected / review</span><strong>{selectedCount}</strong></div>
        <div><span>Urgent</span><strong className="urgent-number">{urgentCount}</strong></div>
        <div><span>Consensus</span><strong>{consensusCount}</strong></div>
      </section>

      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError("")} aria-label="Dismiss error"><XMarkIcon /></button></div>}

      <div className={`workspace-grid ${selectedCase ? "with-detail" : ""}`}>
        <section className="queue-panel">
          <div className="queue-toolbar">
            <div className="status-tabs" role="tablist" aria-label="Case status">
              {statuses.map((item) => (
                <button key={item.value} type="button" className={statusFilter === item.value ? "active" : ""} onClick={() => setStatusFilter(item.value)} role="tab" aria-selected={statusFilter === item.value}>{item.label}</button>
              ))}
            </div>
            <label className="search-box">
              <MagnifyingGlassIcon />
              <span className="sr-only">Search cases</span>
              <input type="search" placeholder="Search accession, patient, anatomy" value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
          </div>

          <div className="case-list" aria-live="polite">
            <div className="case-list-header"><span>Case</span><span>Clinical question</span><span>Status</span><span>Updated</span></div>
            {loading && <div className="empty-state"><ClockIcon /><h2>Loading queue</h2></div>}
            {!loading && visibleCases.length === 0 && (
              <div className="empty-state"><CheckCircleIcon /><h2>No cases in this view</h2><p>Adjust the filters or add a candidate.</p></div>
            )}
            {visibleCases.map((item) => (
              <button className={`case-row ${selectedId === item.id ? "selected" : ""}`} type="button" key={item.id} onClick={() => setSelectedId(item.id)}>
                <span className="case-identity"><strong>{item.accession_number}</strong><small>{item.modality} / {item.body_part} / {item.patient_reference}</small></span>
                <span className="clinical-question">{item.clinical_question}</span>
                <span className="case-state"><span className={`status status-${item.status}`}>{formatStatus(item.status)}</span>{item.priority !== "routine" && <span className={`priority priority-${item.priority}`}>{item.priority}</span>}</span>
                <span className="updated-time">{formatDate(item.updated_at)}<small>{item.review_count} notes</small></span>
              </button>
            ))}
          </div>
        </section>

        {selectedCase && <CaseDetail selectedCase={selectedCase} reviews={reviews} onUpdate={updateSelected} onReview={addReview} onClose={() => setSelectedId(null)} />}
      </div>

      {showForm && <CaseForm onClose={() => setShowForm(false)} onCreated={(created) => { setCases((current) => [created, ...current]); setSelectedId(created.id); setShowForm(false); }} />}
    </main>
  );
}

export default function App() {
  return (
    <>
      <UnauthenticatedTemplate><LoginComponent /></UnauthenticatedTemplate>
      <AuthenticatedTemplate><Workspace /></AuthenticatedTemplate>
    </>
  );
}