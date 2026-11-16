import { useEffect, useRef } from "react";
import { X } from "@phosphor-icons/react";

const MISSING = "Chưa có thông tin";

function SimRow({ kind, label, sim }) {
  const phone = sim?.phone || "";
  const serial = sim?.serial || "";
  return (
    <div className="tvSimRowCard">
      <div className="tvSimRowHead">
        <span className={`tvSimKind ${kind}`}>{label}</span>
      </div>
      <dl className="tvSimFields">
        <div>
          <dt>Số điện thoại</dt>
          <dd className={phone ? "mono" : "tvSimMissing"}>{phone || MISSING}</dd>
        </div>
        <div>
          <dt>Serial SIM</dt>
          <dd className={serial ? "mono" : "tvSimMissing"}>{serial || MISSING}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * SIM details for one AIBOX unit.
 *
 * Deliberately a small modal rather than a drawer: the sheet holds four short
 * values, and a full-height panel would leave most of it empty.
 */
export function TvSimDialog({ info, ip, name, onClose, returnFocusRef }) {
  const closeRef = useRef(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();

    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll(
        "button:not(:disabled), [href], [tabindex]:not([tabindex='-1'])",
      )].filter((element) => element.getClientRects().length);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      // Return focus to the row that opened this dialog, falling back to
      // whatever was focused before so the tab order never restarts at the top.
      const target = returnFocusRef?.current || previous;
      if (target && typeof target.focus === "function") target.focus();
    };
  }, [onClose, returnFocusRef]);

  const titleId = `tv-sim-title-${ip}`;

  return (
    <div className="tvSimDialogWrap" role="presentation">
      <button aria-label="Đóng thông tin SIM" className="tvSimDialogBackdrop" onClick={onClose} type="button" />
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="tvSimDialog"
        ref={dialogRef}
        role="dialog"
      >
        <header className="tvSimDialogHead">
          <div>
            <span className="tvSimKicker">Thông tin SIM</span>
            <h2 id={titleId}>{name || ip}</h2>
            <p className="tvSimHost mono">{info ? info.hostname || "—" : "—"} · {ip}</p>
          </div>
          <button aria-label="Đóng" className="tvSimDialogClose" onClick={onClose} ref={closeRef} type="button">
            <X aria-hidden="true" size={18} weight="bold" />
          </button>
        </header>

        {info ? (
          <div className="tvSimRows">
            <SimRow kind="aibox" label="AIBOX" sim={info.aibox} />
            <SimRow kind="router" label="Router" sim={info.router} />
          </div>
        ) : (
          <p className="tvSimEmpty">Chưa có thông tin SIM cho thiết bị này.</p>
        )}
      </div>
    </div>
  );
}
