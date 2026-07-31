"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

const STORAGE_KEY = "ssc-outdoor-mode";

interface OutdoorModeContextValue {
  outdoorMode: boolean;
  toggle: () => void;
}

const OutdoorModeContext = createContext<OutdoorModeContextValue | null>(null);

export function OutdoorModeProvider({ children }: { children: React.ReactNode }) {
  const [outdoorMode, setOutdoorMode] = useState(false);

  useEffect(() => {
    if (window.localStorage.getItem(STORAGE_KEY) === "1") setOutdoorMode(true);
  }, []);

  const toggle = useCallback(() => {
    setOutdoorMode((prev) => {
      const next = !prev;
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  return (
    <OutdoorModeContext.Provider value={{ outdoorMode, toggle }}>
      {children}
    </OutdoorModeContext.Provider>
  );
}

export function useOutdoorMode(): OutdoorModeContextValue {
  const ctx = useContext(OutdoorModeContext);
  if (!ctx) {
    throw new Error("useOutdoorMode must be used within an OutdoorModeProvider");
  }
  return ctx;
}
