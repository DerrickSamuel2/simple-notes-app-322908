import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/**
 * Notes app layout:
 * - Header with app name and primary actions
 * - Left panel: notes list + search
 * - Right panel: note detail editor
 *
 * The backend OpenAPI currently only shows "/" health. This frontend is implemented
 * to call typical CRUD endpoints and will gracefully show an error state if the
 * endpoints are missing/unavailable.
 */

const DEFAULT_API_BASE_URL = "";

/**
 * Derive API base URL.
 * - In CRA, you can set REACT_APP_NOTES_API_BASE_URL to point to the backend (e.g. http://localhost:3001).
 * - If unset, it will use same-origin (useful when a dev proxy or reverse proxy is configured).
 */
function getApiBaseUrl() {
  return (process.env.REACT_APP_NOTES_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/$/, "");
}

/**
 * Try common endpoint shapes:
 * - /notes
 * - /api/notes
 */
function candidateNotesBases(apiBaseUrl) {
  const bases = [`${apiBaseUrl}/notes`, `${apiBaseUrl}/api/notes`];
  // Deduplicate while preserving order
  return [...new Set(bases)];
}

// PUBLIC_INTERFACE
function App() {
  const apiBaseUrl = useMemo(() => getApiBaseUrl(), []);
  const [notesBase, setNotesBase] = useState(null); // resolved base, e.g. https://.../notes
  const [apiError, setApiError] = useState(null);

  const [notes, setNotes] = useState([]);
  const [selectedId, setSelectedId] = useState(null);

  const [query, setQuery] = useState("");

  const [isLoadingList, setIsLoadingList] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const [editorTitle, setEditorTitle] = useState("");
  const [editorContent, setEditorContent] = useState("");
  const [editorDirty, setEditorDirty] = useState(false);

  const [toast, setToast] = useState(null);

  const toastTimerRef = useRef(null);

  const selectedNote = useMemo(() => {
    if (!selectedId) return null;
    return notes.find((n) => String(n.id) === String(selectedId)) || null;
  }, [notes, selectedId]);

  const filteredNotes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((n) => {
      const t = (n.title || "").toLowerCase();
      const c = (n.content || "").toLowerCase();
      return t.includes(q) || c.includes(q);
    });
  }, [notes, query]);

  function showToast(message, variant = "info") {
    setToast({ message, variant });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2400);
  }

  async function fetchJson(url, options) {
    const res = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        ...(options && options.headers ? options.headers : {}),
      },
      ...options,
    });

    let payload = null;
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      payload = await res.json().catch(() => null);
    } else {
      const text = await res.text().catch(() => "");
      payload = text ? { detail: text } : null;
    }

    if (!res.ok) {
      const detail =
        (payload && (payload.detail || payload.message)) ||
        `Request failed (${res.status})`;
      const err = new Error(detail);
      // Attach additional context for UI
      err.status = res.status;
      err.payload = payload;
      throw err;
    }

    return payload;
  }

  /**
   * Attempt to discover which base path exists on the backend.
   * We try GET {base} and accept:
   * - 200 (list response)
   * - 405 (method not allowed) indicates route exists but maybe needs different method
   */
  async function resolveNotesBase() {
    setApiError(null);
    const candidates = candidateNotesBases(apiBaseUrl);

    for (const base of candidates) {
      try {
        const res = await fetch(`${base}`, { method: "GET" });
        if (res.ok || res.status === 405) {
          setNotesBase(base);
          return base;
        }
      } catch (e) {
        // ignore and try next
      }
    }

    const msg =
      "Notes API endpoints were not found. Backend OpenAPI currently exposes only '/'. " +
      "Expected '/notes' or '/api/notes'.";
    setApiError(msg);
    setNotesBase(null);
    return null;
  }

  function normalizeNote(raw) {
    // Try to be resilient to backend naming differences.
    return {
      id: raw.id ?? raw.note_id ?? raw.uuid ?? raw._id,
      title: raw.title ?? "",
      content: raw.content ?? raw.body ?? "",
      created_at: raw.created_at ?? raw.createdAt ?? null,
      updated_at: raw.updated_at ?? raw.updatedAt ?? null,
    };
  }

  async function loadNotes(baseOverride) {
    const base = baseOverride || notesBase || (await resolveNotesBase());
    if (!base) return;

    setIsLoadingList(true);
    setApiError(null);
    try {
      const data = await fetchJson(`${base}`, { method: "GET" });
      const list = Array.isArray(data) ? data : data?.items || data?.notes || [];
      const normalized = (list || []).map(normalizeNote);
      setNotes(normalized);

      // Keep selection stable if possible
      if (normalized.length === 0) {
        setSelectedId(null);
      } else if (selectedId) {
        const stillExists = normalized.some((n) => String(n.id) === String(selectedId));
        if (!stillExists) setSelectedId(String(normalized[0].id));
      } else {
        setSelectedId(String(normalized[0].id));
      }
    } catch (e) {
      setApiError(e.message || "Failed to load notes.");
    } finally {
      setIsLoadingList(false);
    }
  }

  function setEditorFromNote(note) {
    setEditorTitle(note?.title || "");
    setEditorContent(note?.content || "");
    setEditorDirty(false);
  }

  useEffect(() => {
    // initial discovery + load
    (async () => {
      const base = await resolveNotesBase();
      await loadNotes(base);
    })();

    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // when selection changes, sync editor
    if (!selectedNote) {
      setEditorTitle("");
      setEditorContent("");
      setEditorDirty(false);
      return;
    }
    setEditorFromNote(selectedNote);
  }, [selectedNote]);

  async function createNote() {
    const base = notesBase || (await resolveNotesBase());
    if (!base) return;

    setIsSaving(true);
    setApiError(null);
    try {
      const payload = {
        title: "Untitled",
        content: "",
      };
      const created = await fetchJson(`${base}`, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      const newNote = normalizeNote(created);
      if (!newNote.id) {
        // If backend returns list or wrapper
        showToast("Created note, reloading…", "info");
        await loadNotes(base);
        return;
      }

      setNotes((prev) => [newNote, ...prev]);
      setSelectedId(String(newNote.id));
      showToast("Note created", "success");
    } catch (e) {
      setApiError(e.message || "Failed to create note.");
    } finally {
      setIsSaving(false);
    }
  }

  async function saveNote() {
    if (!selectedNote) return;
    const base = notesBase || (await resolveNotesBase());
    if (!base) return;

    setIsSaving(true);
    setApiError(null);
    try {
      const payload = {
        title: editorTitle.trim(),
        content: editorContent,
      };

      const updated = await fetchJson(`${base}/${encodeURIComponent(String(selectedNote.id))}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });

      const updatedNote = normalizeNote(updated);
      setNotes((prev) =>
        prev.map((n) => (String(n.id) === String(selectedNote.id) ? { ...n, ...updatedNote } : n))
      );
      setEditorDirty(false);
      showToast("Saved", "success");
    } catch (e) {
      setApiError(e.message || "Failed to save note.");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteNote() {
    if (!selectedNote) return;
    const base = notesBase || (await resolveNotesBase());
    if (!base) return;

    const ok = window.confirm("Delete this note? This cannot be undone.");
    if (!ok) return;

    setIsDeleting(true);
    setApiError(null);
    try {
      await fetchJson(`${base}/${encodeURIComponent(String(selectedNote.id))}`, {
        method: "DELETE",
      });

      setNotes((prev) => prev.filter((n) => String(n.id) !== String(selectedNote.id)));
      setSelectedId((prevSelected) => {
        if (String(prevSelected) !== String(selectedNote.id)) return prevSelected;
        // pick next available
        const remaining = notes.filter((n) => String(n.id) !== String(selectedNote.id));
        return remaining.length ? String(remaining[0].id) : null;
      });

      showToast("Deleted", "success");
    } catch (e) {
      setApiError(e.message || "Failed to delete note.");
    } finally {
      setIsDeleting(false);
    }
  }

  const canSave =
    !!selectedNote && editorDirty && editorTitle.trim().length > 0 && !isSaving && !isDeleting;

  return (
    <div className="notes-app">
      <header className="header">
        <div className="header__left">
          <div className="brand">
            <div className="brand__mark" aria-hidden="true">
              N
            </div>
            <div className="brand__text">
              <div className="brand__title">Notes</div>
              <div className="brand__subtitle">Simple CRUD notes</div>
            </div>
          </div>
        </div>

        <div className="header__actions">
          <button className="btn btn--primary" onClick={createNote} disabled={isSaving || isDeleting}>
            New
          </button>
          <button className="btn btn--ghost" onClick={() => loadNotes()} disabled={isLoadingList}>
            Refresh
          </button>
        </div>
      </header>

      {toast ? (
        <div className={`toast toast--${toast.variant}`} role="status" aria-live="polite">
          {toast.message}
        </div>
      ) : null}

      <main className="main">
        <section className="panel panel--list" aria-label="Notes list">
          <div className="panel__top">
            <div className="panel__titleRow">
              <h2 className="panel__title">Your notes</h2>
              <span className="pill">{filteredNotes.length}</span>
            </div>

            <label className="search">
              <span className="sr-only">Search notes</span>
              <input
                className="input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by title or content…"
              />
            </label>
          </div>

          <div className="panel__body">
            {isLoadingList ? (
              <div className="state">
                <div className="spinner" aria-hidden="true" />
                <div className="state__text">Loading notes…</div>
              </div>
            ) : apiError ? (
              <div className="state state--error">
                <div className="state__title">Couldn’t load notes</div>
                <div className="state__text">{apiError}</div>
                <div className="state__hint">
                  Set <code>REACT_APP_NOTES_API_BASE_URL</code> to your backend URL (e.g.
                  <code> http://localhost:3001</code>) and ensure <code>/notes</code> (or{" "}
                  <code>/api/notes</code>) exists.
                </div>
              </div>
            ) : filteredNotes.length === 0 ? (
              <div className="state">
                <div className="state__title">No notes yet</div>
                <div className="state__text">Create your first note to get started.</div>
                <button className="btn btn--primary" onClick={createNote} disabled={isSaving || isDeleting}>
                  Create a note
                </button>
              </div>
            ) : (
              <ul className="notesList">
                {filteredNotes.map((n) => {
                  const isActive = selectedId && String(n.id) === String(selectedId);
                  return (
                    <li key={String(n.id)}>
                      <button
                        className={`noteCard ${isActive ? "noteCard--active" : ""}`}
                        onClick={() => setSelectedId(String(n.id))}
                      >
                        <div className="noteCard__title">{n.title || "Untitled"}</div>
                        <div className="noteCard__preview">
                          {(n.content || "").trim() ? (n.content || "").trim() : "No content"}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        <section className="panel panel--editor" aria-label="Note editor">
          <div className="panel__top">
            <div className="panel__titleRow">
              <h2 className="panel__title">Details</h2>
              {selectedNote ? (
                <span className={`statusDot ${editorDirty ? "statusDot--warn" : "statusDot--ok"}`}>
                  {editorDirty ? "Unsaved" : "Saved"}
                </span>
              ) : (
                <span className="statusDot statusDot--muted">No selection</span>
              )}
            </div>

            <div className="editorActions">
              <button className="btn btn--primary" onClick={saveNote} disabled={!canSave}>
                {isSaving ? "Saving…" : "Save"}
              </button>
              <button
                className="btn btn--danger"
                onClick={deleteNote}
                disabled={!selectedNote || isSaving || isDeleting}
              >
                {isDeleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>

          <div className="panel__body panel__body--editor">
            {!selectedNote ? (
              <div className="state">
                <div className="state__title">Select a note</div>
                <div className="state__text">Choose a note on the left, or create a new one.</div>
              </div>
            ) : (
              <form
                className="editor"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (canSave) saveNote();
                }}
              >
                <label className="field">
                  <div className="field__label">Title</div>
                  <input
                    className="input input--title"
                    value={editorTitle}
                    onChange={(e) => {
                      setEditorTitle(e.target.value);
                      setEditorDirty(true);
                    }}
                    placeholder="Note title"
                  />
                  {editorTitle.trim().length === 0 ? (
                    <div className="field__help field__help--error">Title is required.</div>
                  ) : null}
                </label>

                <label className="field">
                  <div className="field__label">Content</div>
                  <textarea
                    className="textarea"
                    value={editorContent}
                    onChange={(e) => {
                      setEditorContent(e.target.value);
                      setEditorDirty(true);
                    }}
                    placeholder="Write your note…"
                    rows={12}
                  />
                </label>

                <div className="editor__footer">
                  <div className="editor__meta">
                    API:{" "}
                    <code>{notesBase ? notesBase : candidateNotesBases(apiBaseUrl).join(" | ")}</code>
                  </div>
                  <button className="btn btn--primary" type="submit" disabled={!canSave}>
                    Save changes
                  </button>
                </div>
              </form>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
