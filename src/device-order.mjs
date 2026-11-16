export const CONNECTIVITY_ORDER_KEY = "aiboxConnectivityDeviceOrder";

export function parseDeviceOrder(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value, index, list) => typeof value === "string" && value && list.indexOf(value) === index);
  } catch {
    return [];
  }
}

export function loadDeviceOrder(storage) {
  try {
    const raw = storage && typeof storage.getItem === "function" ? storage.getItem(CONNECTIVITY_ORDER_KEY) : null;
    return parseDeviceOrder(raw);
  } catch {
    return [];
  }
}

export function saveDeviceOrder(storage, ips) {
  try {
    if (!ips || !ips.length) storage.removeItem(CONNECTIVITY_ORDER_KEY);
    else storage.setItem(CONNECTIVITY_ORDER_KEY, JSON.stringify(ips));
    return true;
  } catch {
    return false;
  }
}

export function orderDevices(machines, savedIps) {
  if (!savedIps || !savedIps.length) return machines;
  const byIp = new Map(machines.map((machine) => [machine.ip, machine]));
  const ordered = [];
  const used = new Set();
  savedIps.forEach((ip) => {
    const machine = byIp.get(ip);
    if (machine && !used.has(ip)) {
      ordered.push(machine);
      used.add(ip);
    }
  });
  machines.forEach((machine) => {
    if (!used.has(machine.ip)) ordered.push(machine);
  });
  return ordered;
}

export function moveDevice(list, from, to) {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
