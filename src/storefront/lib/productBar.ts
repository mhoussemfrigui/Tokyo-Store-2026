import { useSyncExternalStore } from "react";

type View = "product" | "nav";
type State = { active: boolean; view: View };

let state: State = { active: false, view: "product" };
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const productBarStore = {
  get: () => state,
  set: (next: Partial<State>) => {
    state = { ...state, ...next };
    emit();
  },
  subscribe: (fn: () => void) => {
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  },
};

export function useProductBar() {
  return useSyncExternalStore(productBarStore.subscribe, productBarStore.get, productBarStore.get);
}
