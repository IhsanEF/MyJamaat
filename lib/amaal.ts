export const standardAmal = [
  "Khidmah", "Responsible of Ta'leem", "Dhuhr Ta'leem/Talk", "Asr Ta'leem",
  "Adaab Jawla", "Sit & Talk", "Istiqbaal", "Dhikr", "Bayaan",
  "Hayaat al-Sahaba", "Fajr Bayaan",
];

export const mastooraatAmal = [
  "Mastooraat Ta'leem", "Mudhakarah", "Mudhakarah from Men",
  "Bayaan from Men", "Returning Home Talk",
];

export const amalForJamaat = (kind: unknown) => [
  ...standardAmal, ...(kind === "mastooraat" ? mastooraatAmal : []),
];

export function isCalendarDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}
