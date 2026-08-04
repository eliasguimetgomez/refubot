import test from "node:test";
import assert from "node:assert/strict";
import { classifyBookingState, EXPECTED_RANGE } from "../scripts/availability-logic.mjs";

test("accepts only the exact requested range with an enabled Continue button", () => {
  assert.deepEqual(classifyBookingState({
    selectedRange: EXPECTED_RANGE,
    continueVisible: true,
    continueEnabled: true,
    bookingText: "Would you like to include another hut? Continue"
  }), {
    status: "available",
    reason: "one-interior-bed-can-continue"
  });
});

test("rejects the full-arrival message observed on the live site", () => {
  assert.deepEqual(classifyBookingState({
    selectedRange: EXPECTED_RANGE,
    continueVisible: false,
    continueEnabled: false,
    bookingText: "A full day cannot be selected as the arrival date"
  }), {
    status: "unavailable",
    reason: "booking-flow-rejected"
  });
});

test("does not claim availability when the final control is missing", () => {
  assert.deepEqual(classifyBookingState({
    selectedRange: EXPECTED_RANGE,
    continueVisible: false,
    continueEnabled: false,
    bookingText: ""
  }), {
    status: "unknown",
    reason: "continue-control-not-offered"
  });
});

test("does not claim availability for another date range", () => {
  assert.deepEqual(classifyBookingState({
    selectedRange: "2026-08-18 - 2026-08-19",
    continueVisible: true,
    continueEnabled: true,
    bookingText: "Continue"
  }), {
    status: "unknown",
    reason: "date-range-not-confirmed"
  });
});
