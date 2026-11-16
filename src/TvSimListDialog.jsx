import { useEffect, useRef } from "react";
import { X } from "@phosphor-icons/react";
import { TV_SIM_LIST } from "./tv-sim-data.mjs";

const MISSING = "—";

function SimCell({ value, mono }) {
  if (!value) return <td className="tvSimMissing">{MISSING}</td>;
  return <td className={mono ? "mono" : undefined}>{value}</td>;
}

function SiteRows({ entry }) {
  return (
    <>
      <tr>
        <th className="tvSimSite" rowSpan={2} scope="rowgroup">{entry.site}</th>
        <td className="mono">{entry.hostname || MISSING}</td>
        <td><span className="tvSimKind aibox">AIBOX</span></td>
        <SimCell mono value={entry.aibox.phone} />
        <SimCell mono value={entry.aibox.serial} />
      </tr>
      <tr>
        <td className="mono tvSimHostCell">{entry.hostname || MISSING}</td>
        <td><span className="tvSimKind router">Router</span></td>
        <SimCell mono value={entry.router.phone} />
        <SimCell mono value={entry.router.serial} />
      </tr>
    </>
  );
}

export function TvSimListDialog({ onClose, returnFocusRef }) {
  const closeRef = useRef(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    function onKeyDown(event) {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll("button:not(:disabled), [href], [tabindex]:not([tabindex='-1'])")]
        .filter((element) => element.getClientRects().length);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      const target = returnFocusRef?.current || previous;
      if (target && typeof target.focus === "function") target.focus();
    };
  }, [onClose, returnFocusRef]);

  return (
    <div className="tvSimDialogWrap" role="presentation">
      <button aria-label="Đóng danh sách SIM" className="tvSimDialogBackdrop" onClick={onClose} type="button" />
      <div aria-labelledby="tv-sim-list-title" aria-modal="true" className="tvSimDialog tvSimListDialog" ref={dialogRef} role="dialog">
        <header className="tvSimDialogHead">
          <div>
            <span className="tvSimKicker">SIM 4G</span>
            <h2 id="tv-sim-list-title">Danh sách SIM</h2>
            <p className="tvSimHost">{TV_SIM_LIST.length} thiết bị · số điện thoại và serial</p>
          </div>
          <button aria-label="Đóng" className="tvSimDialogClose" onClick={onClose} ref={closeRef} type="button">
            <X aria-hidden="true" size={18} weight="bold" />
          </button>
        </header>
        <div className="tvSimListScroll" role="region" aria-label="Danh sách SIM theo trạm" tabIndex={0}>
          <table className="tvSimTable">
            <thead>
              <tr>
                <th scope="col">Trạm</th>
                <th scope="col">Tên hệ thống</th>
                <th scope="col">Gắn vào</th>
                <th scope="col">Số điện thoại</th>
                <th scope="col">Serial SIM</th>
              </tr>
            </thead>
            <tbody>
              {TV_SIM_LIST.map((entry, index) => (
                <SiteRows entry={entry} key={`${entry.site}-${entry.hostname}-${index}`} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}