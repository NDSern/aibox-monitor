// SIM inventory for AIBOX units, transcribed from the operations sheet.
//
// Keys are the AIBOX tailnet IP the dashboard already uses, so a row can be
// resolved without matching on a display name that changes between sites.
//
// Phone numbers are kept as strings on purpose: several begin with 0, and one
// leading digit silently disappears if the value is ever treated as a number.
// Serial numbers are likewise opaque identifiers, not quantities.

function device(site, hostname, aibox, router) {
  return {
    site,
    hostname,
    aibox: { phone: aibox.phone || "", serial: aibox.serial || "" },
    router: { phone: router.phone || "", serial: router.serial || "" },
  };
}

export const TV_SIM_DIRECTORY = {
  "100.64.0.45": device("Poseidon", "VTAS-AIBOX1",
    { phone: "0779554619", serial: "8406250412421998" },
    { phone: "0779921174", serial: "8406250412422002" }),

  "100.64.0.44": device("Star City", "VTAS-AIBOX2",
    { phone: "0779386659", serial: "8406250412422000" },
    { phone: "0779128603", serial: "8406250412422003" }),

  "100.64.0.80": device("Oceanus", "VTAS-AIBOX3",
    { phone: "0779984695", serial: "8406250412421997" },
    { phone: "0777170637", serial: "8406250812050918" }),

  "100.64.0.85": device("Neptune", "VTAS-AIBOX4",
    { phone: "0777802500", serial: "8406250812050922" },
    { phone: "0777913664", serial: "8406250812050915" }),

  "100.64.0.123": device("TH09", "AIBOX-TH09",
    { phone: "0777008538", serial: "8406250812050962" },
    { phone: "0778911720", serial: "8406250812050963" }),

  "100.64.0.122": device("TH08", "aibox-spare-3",
    { phone: "0778615874", serial: "8406250812050960" },
    { phone: "0777534742", serial: "8406250812050974" }),

  "100.64.0.104": device("TH07", "VTA-AIBOX11",
    { phone: "0777094953", serial: "8406250812050916" },
    { phone: "0777192107", serial: "8406250812050921" }),

  "100.64.0.82": device("TH06", "VTA-AIBOX10",
    { phone: "0777055869", serial: "8406250812050917" },
    { phone: "0777172928", serial: "8406250812050914" }),

  "100.64.0.81": device("TH05", "VTA-AIBOX9",
    { phone: "0779132692", serial: "8406250412422001" },
    { phone: "0777125360", serial: "8406250812050923" }),

  // Phone column is blank on the sheet for both SIMs of this unit.
  "100.64.0.1": device("TH04", "AIBOX6",
    { phone: "", serial: "8401240112250394" },
    { phone: "", serial: "8401240112250391" }),

  "100.64.0.121": device("TD09", "AIBOX-SPARE-2",
    { phone: "0778261612", serial: "8406250812050958" },
    { phone: "0778677375", serial: "8406250812050959" }),

  "100.64.0.27": device("TD08", "AIBOX8",
    { phone: "0779810583", serial: "8406250412422006" },
    { phone: "0779224895", serial: "" }),

  "100.64.0.6": device("TD07", "AIBOX7",
    { phone: "", serial: "8401240112250393" },
    { phone: "0778948021", serial: "8406250812050975" }),

  "100.64.0.8": device("TH02", "",
    { phone: "", serial: "8406250412290411" },
    { phone: "0777513714", serial: "8406250812050919" }),
};

// Units with no known tailnet address still belong in the full list.
const EXTRA_SIMS = [
  device("TH01", "AIBOX1", { phone: "", serial: "8406250412290410" }, { phone: "", serial: "" }),
  device("TH03", "", { phone: "", serial: "" }, { phone: "", serial: "" }),
];

/** Every SIM row for the site-wide list, sorted by site then hostname. */
export const TV_SIM_LIST = Object.keys(TV_SIM_DIRECTORY)
  .map((ip) => ({ ip, ...TV_SIM_DIRECTORY[ip] }))
  .concat(EXTRA_SIMS.map((entry) => ({ ip: "", ...entry })))
  .sort((a, b) => a.site.localeCompare(b.site, "vi") || a.hostname.localeCompare(b.hostname, "vi"));

/** Look up one unit's SIM rows, or null when the sheet has no entry. */
export function simInfoFor(ip) {
  if (!ip) return null;
  return TV_SIM_DIRECTORY[ip] || null;
}
