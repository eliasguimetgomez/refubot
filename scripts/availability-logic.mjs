export const EXPECTED_RANGE = "2026-08-17 - 2026-08-18";

const REJECTION_PATTERNS = [
  /full day cannot be selected as the arrival date/i,
  /d[ií]a completo.+fecha de llegada/i,
  /jour complet.+date d.arriv[ée]e/i,
  /giorno completo.+check-?in/i,
  /no hay plazas/i,
  /sin plazas/i,
  /plazas agotadas/i,
  /no availability/i,
  /not available/i,
  /nessuna disponibilit[àa]/i
];

export function classifyBookingState({
  selectedRange,
  continueVisible,
  continueEnabled,
  bookingText
}) {
  const rejection = REJECTION_PATTERNS.find((pattern) => pattern.test(bookingText));

  if (rejection) {
    return { status: "unavailable", reason: "booking-flow-rejected" };
  }

  if (selectedRange !== EXPECTED_RANGE) {
    return { status: "unknown", reason: "date-range-not-confirmed" };
  }

  if (!continueVisible || !continueEnabled) {
    return { status: "unknown", reason: "continue-control-not-offered" };
  }

  return { status: "available", reason: "one-interior-bed-can-continue" };
}
