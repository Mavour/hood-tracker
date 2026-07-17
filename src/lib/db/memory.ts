/**
 * Process-wide singleton memory store.
 * Simplified to match UniLP-Monitoring — removed deposits/events ETH fields.
 */

import fs from "fs";
import path from "path";

export type MemStore = {
  positions: Map<string, Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  jobs: Map<string, Record<string, unknown>>;
  pnlCache: Map<string, Record<string, unknown>>;
  deposits: Map<string, Record<string, unknown>>;
  cashflows: Array<Record<string, unknown>>;
  closeHistory: Array<Record<string, unknown>>;
  running: Map<string, Promise<unknown>>;
};

type GlobalMem = typeof globalThis & {
  __hoodTrackerMem?: MemStore;
};

const DATA_DIR = path.join(process.cwd(), ".data");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const CACHE_FILE = path.join(DATA_DIR, "pnl-cache.json");

function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function loadMapFile(file: string): Map<string, Record<string, unknown>> {
  try {
    if (!fs.existsSync(file)) return new Map();
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}

function saveMapFile(
  file: string,
  map: Map<string, Record<string, unknown>>,
) {
  try {
    ensureDir();
    const obj: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of map) obj[k] = v;
    fs.writeFileSync(file, JSON.stringify(obj));
  } catch (e) {
    console.warn("[mem] persist failed", e instanceof Error ? e.message : e);
  }
}

export function getMem(): MemStore {
  const g = globalThis as GlobalMem;
  if (!g.__hoodTrackerMem) {
    g.__hoodTrackerMem = {
      positions: new Map(),
      events: [],
      jobs: loadMapFile(JOBS_FILE),
      pnlCache: loadMapFile(CACHE_FILE),
      deposits: new Map(),
      cashflows: [],
      closeHistory: [],
      running: new Map(),
    };
  }
  return g.__hoodTrackerMem;
}

export function persistJobs() {
  saveMapFile(JOBS_FILE, getMem().jobs);
}

export function persistPnlCache() {
  saveMapFile(CACHE_FILE, getMem().pnlCache);
}
