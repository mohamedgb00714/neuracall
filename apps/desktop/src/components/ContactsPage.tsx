import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ContactSummary, CrmCall, TranscriptEntry } from "../types";

/** Add-contact form state. Phones and tags are free text until submit. */
interface ContactForm {
  displayName: string;
  org: string;
  phones: string;
  tags: string;
  notes: string;
}

const EMPTY_FORM: ContactForm = { displayName: "", org: "", phones: "", tags: "", notes: "" };

/** Which of the three shapes the page can be in. */
type Phase = "loading" | "unavailable" | "ready";

/** The history for one contact, tagged so a stale response is not shown under the next. */
interface CallHistory {
  contactId: string;
  calls: CrmCall[];
}

function parseList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function formatWhen(at: number): string {
  return new Date(at).toLocaleString();
}

/**
 * How long the call lasted, or null while it is still running — the clock is
 * never read during render, so a live call says "in progress" instead of
 * showing a number that would silently freeze.
 */
function formatDuration(call: CrmCall): string | null {
  if (call.endedAt === null) return null;
  return `${Math.max(0, Math.round((call.endedAt - call.startedAt) / 1000))}s`;
}

function matches(contact: ContactSummary, query: string): boolean {
  if (query === "") return true;
  const needle = query.toLowerCase();
  return (
    contact.displayName.toLowerCase().includes(needle) ||
    (contact.org ?? "").toLowerCase().includes(needle) ||
    contact.phones.some((phone) => phone.raw.includes(needle) || phone.e164.includes(needle))
  );
}

/**
 * Contacts: who called, what was said, and the form that turns an unknown
 * number into a name.
 *
 * Everything comes from the CRM in the main process over IPC — the renderer
 * only ever holds DTOs. The database is optional: Electron pins Node 20, which
 * has no `node:sqlite`, and the runtime then records calls to JSONL with no
 * contacts at all. That case is a first-class state here, not an error.
 */
export function ContactsPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [recent, setRecent] = useState<CrmCall[]>([]);
  const [history, setHistory] = useState<CallHistory | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<ContactForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const bridge = window.neuracall;
    if (!bridge) return;
    const [nextContacts, nextRecent] = await Promise.all([
      bridge.crmContacts(),
      bridge.crmRecentCalls(),
    ]);
    setContacts(nextContacts);
    setRecent(nextRecent);
  }, []);

  useEffect(() => {
    const bridge = window.neuracall;
    if (!bridge) return; // electron bridge not ready yet
    let cancelled = false;

    bridge
      .crmAvailable()
      .then(async (available) => {
        if (cancelled) return;
        if (!available) {
          setPhase("unavailable");
          return;
        }
        await refresh();
        if (!cancelled) setPhase("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(String(err));
        setPhase("ready");
      });

    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    const bridge = window.neuracall;
    if (!bridge || selected === null) return;
    let cancelled = false;

    bridge
      .crmCalls(selected)
      .then((calls) => {
        if (!cancelled) setHistory({ contactId: selected, calls });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [selected]);

  if (phase === "loading") {
    return (
      <div className="contacts">
        <p className="empty">Loading contacts…</p>
      </div>
    );
  }

  if (phase === "unavailable") {
    return (
      <div className="contacts">
        <div className="contacts-unavailable">
          <h2>No contact database</h2>
          <p>
            Contacts need <code>node:sqlite</code>, which arrived in Node 22. This build of
            Electron ships Node 20, so calls are being recorded to an append-only{" "}
            <code>calls.jsonl</code> instead and there is nothing to look up by caller.
          </p>
          <p className="muted">
            Everything else — answering, transcribing, the call log on the Calls tab — works
            unchanged. Contacts come back on an Electron built against Node 22 or newer.
          </p>
        </div>
      </div>
    );
  }

  const submit = async () => {
    setSaving(true);
    setFormError(null);
    try {
      const result = await window.neuracall.crmCreateContact({
        displayName: form.displayName.trim(),
        org: form.org.trim(),
        notes: form.notes.trim(),
        phones: parseList(form.phones),
        tags: parseList(form.tags),
      });
      if (result.ok && result.contact) {
        setForm(EMPTY_FORM);
        setSelected(result.contact.id);
        await refresh();
      } else {
        setFormError(result.error ?? "Could not add the contact.");
      }
    } catch (err) {
      setFormError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const shown = contacts.filter((contact) => matches(contact, search.trim()));
  const current = contacts.find((contact) => contact.id === selected) ?? null;
  const unlinked = recent.filter((call) => call.contactId === null);
  const calls = history !== null && history.contactId === selected ? history.calls : null;

  return (
    <div className="contacts">
      <aside className="contacts-list">
        <input
          type="search"
          className="contacts-search"
          value={search}
          placeholder="Search name, org or number"
          onChange={(e) => setSearch(e.target.value)}
        />

        {shown.length === 0 ? (
          <p className="empty">
            {contacts.length === 0 ? "No contacts yet." : "Nothing matches that search."}
          </p>
        ) : (
          <ul className="contact-rows">
            {shown.map((contact) => (
              <li key={contact.id}>
                <button
                  type="button"
                  className={`contact-row ${contact.id === selected ? "contact-row-active" : ""}`}
                  onClick={() => setSelected(contact.id)}
                >
                  <span className="contact-name">{contact.displayName}</span>
                  {contact.org !== null && <span className="contact-org">{contact.org}</span>}
                  <span className="contact-phone">
                    {contact.phones[0]?.raw ?? "no number"}
                    {contact.phones.length > 1 ? ` +${contact.phones.length - 1}` : ""}
                  </span>
                  <span className="tag">
                    {contact.callCount} call{contact.callCount === 1 ? "" : "s"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <form
          className="contact-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <h3>Add a contact</h3>
          <FormField label="Name">
            <input
              type="text"
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
          </FormField>
          <FormField label="Organisation">
            <input
              type="text"
              value={form.org}
              onChange={(e) => setForm({ ...form, org: e.target.value })}
            />
          </FormField>
          <FormField label="Numbers" hint="One per line. Anything unparseable is dropped.">
            <textarea
              rows={2}
              value={form.phones}
              onChange={(e) => setForm({ ...form, phones: e.target.value })}
            />
          </FormField>
          <FormField label="Tags" hint="Comma separated.">
            <input
              type="text"
              value={form.tags}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
            />
          </FormField>
          <FormField label="Notes">
            <textarea
              rows={2}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </FormField>
          <button
            type="submit"
            className="btn btn-start"
            disabled={saving || form.displayName.trim() === ""}
          >
            {saving ? "Adding…" : "Add contact"}
          </button>
          {formError !== null && <p className="settings-error">{formError}</p>}
        </form>
      </aside>

      <section className="contacts-detail">
        {error !== null && <p className="settings-error">{error}</p>}

        {current === null ? (
          <p className="empty">Pick a contact to see their calls.</p>
        ) : (
          <article className="contact-detail">
            <header className="contact-detail-head">
              <h2>{current.displayName}</h2>
              {current.org !== null && <span className="muted">{current.org}</span>}
              {current.tags.map((tag) => (
                <span key={tag} className="tag">
                  {tag}
                </span>
              ))}
            </header>
            <p className="muted">
              {current.phones.map((phone) => phone.raw).join(" · ") || "no number on file"}
            </p>
            {current.notes !== null && <p className="contact-notes">{current.notes}</p>}

            <h3>Call history</h3>
            {calls === null ? (
              <p className="empty">Loading calls…</p>
            ) : calls.length === 0 ? (
              <p className="empty">No calls linked to this contact yet.</p>
            ) : (
              calls.map((call) => <CallEntry key={call.callId} call={call} />)
            )}
          </article>
        )}

        <div className="contacts-unknown-head">
          <h3>Calls from unknown numbers</h3>
          {/* Calls land in the database from the main process, which sends no
              event when one is linked — so the operator re-reads on demand. */}
          <button
            type="button"
            onClick={() => {
              refresh().catch((err: unknown) => setError(String(err)));
            }}
          >
            Refresh
          </button>
        </div>
        {unlinked.length === 0 ? (
          <p className="empty">Every recorded call belongs to a contact.</p>
        ) : (
          unlinked.map((call) => (
            <CallEntry
              key={call.callId}
              call={call}
              onAddContact={
                call.remoteParty === null
                  ? undefined
                  : () => setForm({ ...EMPTY_FORM, phones: call.remoteParty ?? "" })
              }
            />
          ))
        )}
      </section>
    </div>
  );
}

function CallEntry({ call, onAddContact }: { call: CrmCall; onAddContact?: () => void }) {
  const duration = formatDuration(call);
  return (
    <article className="call-card">
      <header>
        <strong>{call.remoteParty ?? "unknown number"}</strong>
        <span className="muted">{formatWhen(call.startedAt)}</span>
        <span className="tag">{call.channelId}</span>
        <span className="tag">{call.direction}</span>
        {call.outcome !== null && <span className="tag">{call.outcome}</span>}
        <span className="muted">{duration ?? "in progress"}</span>
        {onAddContact && (
          <button type="button" onClick={onAddContact}>
            Add as contact
          </button>
        )}
      </header>
      {call.error !== undefined && <p className="call-error">{call.error}</p>}
      {call.transcript.length === 0 ? (
        <p className="muted contact-no-transcript">No transcript.</p>
      ) : (
        <ol className="call-transcript">
          {call.transcript.map((entry: TranscriptEntry, i) => (
            <li key={`${entry.at}-${i}`} className={`turn turn-${entry.speaker}`}>
              <span className="who">{entry.speaker === "caller" ? "Caller" : "Agent"}</span>
              <span className="what">{entry.text}</span>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="settings-field">
      <span className="settings-label">{label}</span>
      {children}
      {hint !== undefined && <span className="settings-hint">{hint}</span>}
    </label>
  );
}
