import { useState } from "react";
import KeptSheet from "../components/KeptSheet";
import { Rows, Thing } from "../components/KitchenArt";
import ScreenHead from "../components/ScreenHead";
import Unpack from "../components/Unpack";
import { faded, guess, nameOf, shelvesOf, usedLine } from "../lib/kitchen";
import { useHashSheet, useHashSheetValue } from "../lib/hashSheet";
import { shortDate } from "../lib/pantry";
import { keyOf, useKitchen } from "../lib/useKitchen";
import type { Cook, KitchenFood } from "../types";

interface Props {
  onBack?: () => void;
  onOpenPot: (cookId: string) => void;
}

type Cell = { kind: "pot"; v: Cook } | { kind: "food"; v: KitchenFood };

/**
 * The fridge. Its door swings open as the screen does and the light comes on:
 * the pots on the top shelf at eye level, then the rest, the door's bottles
 * and the vegetable drawer. The freezer is a drawer underneath.
 */
export default function Fridge(p: Props) {
  const k = useKitchen();
  const put = useHashSheet("put", "away");
  const kept = useHashSheetValue("kept");
  const [freezerOpen, setFreezerOpen] = useState(false);

  const zones = k.foods ? shelvesOf(k.foods, "fridge", k.today) : [];
  const zone = (name: string) => zones.find((z) => z.shelf === name)?.items ?? [];
  const frozen = k.foods ? shelvesOf(k.foods, "freezer", k.today)[0]?.items ?? [] : [];
  const open = kept.value && k.foods ? k.foods.find((f) => keyOf(f) === kept.value) ?? null : null;
  const top: Cell[] = [...(k.pots ?? []).map((v) => ({ kind: "pot" as const, v })), ...zone("Shelves").map((v) => ({ kind: "food" as const, v }))];

  const food = (f: KitchenFood, j: number) => (
    <Thing key={keyOf(f)} j={j} art={guess(nameOf(f)).art} size={38} name={nameOf(f)} line={usedLine(f, k.today)} old={faded(f, k.today)} onClick={() => kept.show(keyOf(f))} />
  );
  const cell = (c: Cell, j: number) =>
    c.kind === "pot" ? (
      <Thing key={c.v.id} j={j} art="pot" size={38} name={c.v.name} line={`${Math.round(c.v.remaining_g)} g · ${shortDate(c.v.cooked_on)}`} onClick={() => p.onOpenPot(c.v.id)} />
    ) : (
      food(c.v, j)
    );
  const empty = k.foods !== null && k.pots !== null && top.length + zone("In the door").length + zone("Vegetable drawer").length === 0;

  return (
    <div className="screen">
      <ScreenHead title="Fridge" onBack={p.onBack} action={<button className="btn btn--quiet" onClick={put.show}>Put away</button>} />
      {k.error && <p className="alert" role="alert">{k.error}</p>}

      <div className="fridge">
        <div className="fridge__body">
          <div className="fridge__in">
            <div className="fridge__light" aria-hidden />
            {empty && <p className="fridge__empty">Nothing in the fridge yet. Pots go in by themselves.</p>}
            <Rows items={top} per={3} glass render={cell} />
            {zone("In the door").length > 0 && (
              <>
                <h2 className="fridge__cap">In the door</h2>
                <Rows items={zone("In the door")} per={3} glass start={top.length} render={food} />
              </>
            )}
            {zone("Vegetable drawer").length > 0 && (
              <div className="fridge__drawer">
                <Rows items={zone("Vegetable drawer")} per={3} start={top.length + zone("In the door").length} render={food} />
              </div>
            )}
          </div>
          <div className="fridge__door" aria-hidden><span className="fridge__handle" /></div>
        </div>

        <button className="fridge__freezer" aria-expanded={freezerOpen} onClick={() => setFreezerOpen((o) => !o)}>
          <span className="row__main">
            <span className="row__title">Freezer</span>
            <span className="row__sub">{frozen.length ? frozen.map(nameOf).join(", ") : "Nothing frozen"}</span>
          </span>
          <span className="tnum">{frozen.length}</span>
          <span className={`row__chev${freezerOpen ? " is-open" : ""}`} aria-hidden>›</span>
        </button>
        {freezerOpen && frozen.length > 0 && (
          <div className="fridge__in fridge__in--frozen">
            <Rows items={frozen} per={3} glass render={food} />
          </div>
        )}
      </div>

      <KeptSheet food={open} today={k.today} onClose={kept.hide} onChanged={k.load} />
      <Unpack open={put.open} onClose={put.hide} foods={k.foods ?? []} today={k.today} counts={k.counts} onChanged={k.load} />
    </div>
  );
}
