"use client";
import { create } from "zustand";
import { MAINTENANCE_CODE, MAINTENANCE_MESSAGE } from "./maintenance";

export const useMaintenance = create(() => ({ enabled: false }));

export function assertMaintenanceWritable() {
  if (useMaintenance.getState().enabled) {
    const error = new Error(MAINTENANCE_MESSAGE);
    error.code = MAINTENANCE_CODE;
    error.retryable = false;
    throw error;
  }
}
