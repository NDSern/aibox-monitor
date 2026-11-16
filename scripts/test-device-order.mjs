import assert from "assert";
import {
  CONNECTIVITY_ORDER_KEY,
  loadDeviceOrder,
  moveDevice,
  orderDevices,
  parseDeviceOrder,
  saveDeviceOrder,
} from "../src/device-order.mjs";

const machines = [
  { ip: "10.0.0.1", id: "a" },
  { ip: "10.0.0.2", id: "b" },
  { ip: "10.0.0.3", id: "c" },
];

function fakeStorage(initial) {
  const store = new Map(initial ? [[CONNECTIVITY_ORDER_KEY, initial]] : []);
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
    dump: () => store,
  };
}

// parseDeviceOrder: defensive parsing.
assert.deepStrictEqual(parseDeviceOrder(null), []);
assert.deepStrictEqual(parseDeviceOrder(""), []);
assert.deepStrictEqual(parseDeviceOrder("{not json"), []);
assert.deepStrictEqual(parseDeviceOrder('{"a":1}'), []);
assert.deepStrictEqual(parseDeviceOrder('["x","x","","y",3,null]'), ["x", "y"]);

// loadDeviceOrder: storage failure and normal read.
assert.deepStrictEqual(loadDeviceOrder(undefined), []);
assert.deepStrictEqual(loadDeviceOrder({ getItem: () => { throw new Error("blocked"); } }), []);
assert.deepStrictEqual(loadDeviceOrder(fakeStorage('["10.0.0.3","10.0.0.1"]')), ["10.0.0.3", "10.0.0.1"]);

// saveDeviceOrder: persists, clears, and reports failure.
const storage = fakeStorage();
assert.strictEqual(saveDeviceOrder(storage, ["10.0.0.2", "10.0.0.1"]), true);
assert.strictEqual(storage.dump().get(CONNECTIVITY_ORDER_KEY), '["10.0.0.2","10.0.0.1"]');
assert.strictEqual(saveDeviceOrder(storage, []), true);
assert.strictEqual(storage.dump().has(CONNECTIVITY_ORDER_KEY), false);
assert.strictEqual(saveDeviceOrder({ setItem: () => { throw new Error("full"); }, removeItem: () => {} }, ["x"]), false);

// orderDevices: default order when nothing saved.
assert.deepStrictEqual(orderDevices(machines, []).map((m) => m.ip), ["10.0.0.1", "10.0.0.2", "10.0.0.3"]);

// orderDevices: saved order applied; new devices appended; absent entries ignored.
assert.deepStrictEqual(orderDevices(machines, ["10.0.0.3", "10.0.0.1"]).map((m) => m.ip), ["10.0.0.3", "10.0.0.1", "10.0.0.2"]);
assert.deepStrictEqual(orderDevices(machines, ["10.0.0.9", "10.0.0.2"]).map((m) => m.ip), ["10.0.0.2", "10.0.0.1", "10.0.0.3"]);
assert.deepStrictEqual(orderDevices(machines, ["10.0.0.2", "10.0.0.2"]).map((m) => m.ip), ["10.0.0.2", "10.0.0.1", "10.0.0.3"]);
const added = machines.concat([{ ip: "10.0.0.4", id: "d" }]);
assert.deepStrictEqual(orderDevices(added, ["10.0.0.2"]).map((m) => m.ip), ["10.0.0.2", "10.0.0.1", "10.0.0.3", "10.0.0.4"]);

// moveDevice: reorders and guards boundaries.
assert.deepStrictEqual(moveDevice(["a", "b", "c"], 0, 2), ["b", "c", "a"]);
assert.deepStrictEqual(moveDevice(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
assert.deepStrictEqual(moveDevice(["a", "b", "c"], 1, 1), ["a", "b", "c"]);
assert.deepStrictEqual(moveDevice(["a", "b", "c"], -1, 0), ["a", "b", "c"]);
assert.deepStrictEqual(moveDevice(["a", "b", "c"], 0, 3), ["a", "b", "c"]);

console.log("device-order tests passed");
