import { useCallback, useEffect, useState } from "react";
import { getKitchen, listContainers, listOpenCooks, shiftIso, todayIso } from "../api";
import { counts, KITCHEN_DAYS } from "./kitchen";
import type { Cook, FoodRef, KitchenFood } from "../types";

/**
 * What is at home: the foods, the open pots and the jars you weigh, read
 * again by `load` after anything is put away or moved.
 */
export function useKitchen() {
  const today = todayIso();
  const [data, setData] = useState<{ foods: KitchenFood[]; pots: Cook[]; jars: FoodRef[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [foods, pots, containers] = await Promise.all([
        getKitchen(shiftIso(today, -(KITCHEN_DAYS - 1))),
        listOpenCooks(),
        listContainers(),
      ]);
      setData({ foods, pots, jars: containers.filter((c) => !c.finished).map((c) => c.food) });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [today]);
  useEffect(() => { load(); }, [load]);
  return {
    foods: data?.foods ?? null,
    pots: data?.pots ?? null,
    counts: data ? counts(data.foods, today, data.pots.length, data.jars) : null,
    error,
    load,
    today,
  };
}

/** The key a thing's sheet is opened on in the hash: "fdc:123" or "own:<id>". */
export const keyOf = (f: { fdc_id: number | null; custom_food_id: string | null }): string =>
  f.fdc_id !== null ? `fdc:${f.fdc_id}` : `own:${f.custom_food_id}`;
