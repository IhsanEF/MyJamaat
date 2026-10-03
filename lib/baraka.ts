/** Parse a CAD amount exactly; never round floating point form input. */
export function cadCents(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(value)) throw new Error("Enter a CAD amount with at most two decimal places.");
  const [whole,fraction=""] = value.split(".");
  const cents=Number(whole)*100+Number(fraction.padEnd(2,"0"));
  if (!Number.isSafeInteger(cents) || cents<1 || cents>100000000) throw new Error("Enter an amount from CAD 0.01 to CAD 1,000,000.00.");
  return cents;
}

export function validLedgerCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value>0 && value<=100000000;
}

export function ledgerDelta(type: unknown, cents: unknown): number | null {
  if (!validLedgerCents(cents)) return null;
  return type === "collection" ? cents : type === "expense" ? -cents : null;
}

export function formatCad(cents: number): string {
  const sign=cents<0?"−":"";
  return `${sign}CAD ${(Math.abs(cents)/100).toFixed(2)}`;
}
