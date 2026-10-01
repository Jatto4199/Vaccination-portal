import { STATUS_LABELS } from '../../shared/index.js';

export function StatusChip({ status }) {
  return <span className={`chip chip-${status}`}>{STATUS_LABELS[status] ?? status}</span>;
}

export function Empty({ children }) {
  return <p className="empty">{children}</p>;
}

export function Field({ label, hint, error, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function Modal({ title, onClose, children }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn-icon" onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Loading() {
  return <p className="empty">Loading…</p>;
}

export function Alert({ kind = 'info', children }) {
  return <div className={`alert alert-${kind}`}>{children}</div>;
}
