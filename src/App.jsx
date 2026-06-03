import React, { useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Eye,
  EyeOff,
  RotateCcw,
  Settings,
} from 'lucide-react';

const DEFAULT_OPS = [
  { type: 'set', key: 'item', value: '1' },
  { type: 'set', key: 'greeting', value: '"Hello"' },
  { type: 'set', key: 'item', value: '100' },
  { type: 'set', key: 'point', value: '{"x":5,"y":7}' },
  { type: 'set', key: 'a', value: '1' },
  { type: 'set', key: 'item', value: '1000' },
  { type: 'set', key: 'b', value: '2' },
  { type: 'set', key: 'c', value: '3' },
  { type: 'set', key: 'd', value: '4' },
  { type: 'set', key: 'e', value: '5' },
  { type: 'set', key: 'f', value: '6' },
  { type: 'set', key: 'g', value: '7' },
  { type: 'set', key: 'h', value: '8' },
  { type: 'set', key: 'item', value: '10' },
  { type: 'set', key: 'greeting', value: '"Hello, World!"' },
  { type: 'set', key: 'a', value: '10' },
  { type: 'set', key: 'b', value: '20' },
  { type: 'get', key: 'a' },
  { type: 'get', key: 'b' },
  { type: 'get', key: 'c' },
  { type: 'get', key: 'point' },
  { type: 'get', key: 'item' },
  { type: 'del', key: 'item' },
  { type: 'get', key: 'item' },
  { type: 'del', key: 'greeting' },
  { type: 'del', key: 'point' },
  { type: 'del', key: 'a' },
  { type: 'del', key: 'b' },
  { type: 'del', key: 'c' },
  { type: 'del', key: 'd' },
  { type: 'del', key: 'e' },
  { type: 'del', key: 'f' },
  { type: 'del', key: 'g' },
  { type: 'del', key: 'h' },
  { type: 'get', key: 'never' },
  { type: 'get', key: 'oops' },
];

const TOMBSTONE = '<deleted>';

function hash(key, seed, size) {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return Math.abs(h) % size;
}

function bloomFor(entries, bloomSize, hashes) {
  const bits = Array(bloomSize).fill(0);
  entries.forEach((entry) => {
    for (let i = 0; i < hashes; i += 1) bits[hash(entry.key, i + 17, bloomSize)] = 1;
  });
  return bits;
}

function maybeInBloom(bits, key, hashes) {
  if (!bits.length) return false;
  for (let i = 0; i < hashes; i += 1) {
    if (!bits[hash(key, i + 17, bits.length)]) return false;
  }
  return true;
}

function normalizeSSTableEntries(entriesToNormalize) {
  const latestByKey = new Map();
  entriesToNormalize
    .slice()
    .sort((a, b) => a.time - b.time)
    .forEach((entry) => latestByKey.set(entry.key, entry));

  return Array.from(latestByKey.values()).sort((a, b) => a.key.localeCompare(b.key));
}

function formatMergedName(start, end) {
  return `SSTable${start}_${end}`;
}

function flushEntries(entriesToFlush, sstables, cfg, time, reason, nextIndex) {
  const entries = normalizeSSTableEntries(entriesToFlush);
  if (!entries.length) return { sstables, event: null };

  const next = {
    id: `SSTable-${nextIndex}`,
    name: `SSTable-${nextIndex}`,
    start: nextIndex,
    end: nextIndex,
    level: 0,
    createdAt: time,
    reason,
    entries,
    bloom: bloomFor(entries, cfg.bloomSize, cfg.hashes),
  };

  return { sstables: [...sstables, next], event: `flush:${next.name}` };
}

function touchMemEntry(mem, entry, accessTime) {
  if (mem.has(entry.key)) mem.delete(entry.key);
  mem.set(entry.key, { ...entry, lastUsed: accessTime });
}

function evictLRUFromMemtable(mem, sstables, cfg, time, nextSSTableIndex) {
  const evicted = [];
  while (mem.size > cfg.memtableSize) {
    const lruKey = mem.keys().next().value;
    if (lruKey === undefined) break;
    const lruEntry = mem.get(lruKey);
    mem.delete(lruKey);
    evicted.push(lruEntry);
  }

  if (!evicted.length) return { mem, sstables, nextSSTableIndex, events: [] };

  const flushed = flushEntries(evicted, sstables, cfg, time, 'LRU eviction from MemTable', nextSSTableIndex);
  const events = evicted.map((entry) => `LRU evict ${entry.key} from MemTable`);
  if (flushed.event) events.push(flushed.event);

  return {
    mem,
    sstables: flushed.sstables,
    nextSSTableIndex: flushed.event ? nextSSTableIndex + 1 : nextSSTableIndex,
    events,
  };
}

function mergeTables(left, right, cfg, time) {
  const latest = new Map();
  [left, right]
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
    .forEach((table) => table.entries.forEach((entry) => latest.set(entry.key, entry)));

  const start = Math.min(left.start, right.start);
  const end = Math.max(left.end, right.end);
  const entries = normalizeSSTableEntries(Array.from(latest.values()));

  return {
    id: formatMergedName(start, end),
    name: formatMergedName(start, end),
    start,
    end,
    level: Math.max(left.level, right.level) + 1,
    createdAt: time,
    reason: `merged ${left.name} + ${right.name}`,
    entries,
    bloom: bloomFor(entries, cfg.bloomSize, cfg.hashes),
  };
}

function compact(sstables, cfg, time) {
  let tables = [...sstables];
  const events = [];

  while (true) {
    const activeTables = tables.filter((table) => !table.deleted);
    const mergeablePair = activeTables
      .slice()
      .sort((a, b) => a.level - b.level || a.start - b.start)
      .reduce((pair, table, idx, sorted) => {
        if (pair) return pair;
        const next = sorted[idx + 1];
        if (!next) return null;

        const sameLevel = table.level === next.level;
        const adjacentRanges = table.end + 1 === next.start;
        const sameRangeWidth = table.end - table.start === next.end - next.start;

        return sameLevel && adjacentRanges && sameRangeWidth ? [table, next] : null;
      }, null);

    if (!mergeablePair) break;

    const [left, right] = mergeablePair;
    const merged = mergeTables(left, right, cfg, time);
    tables = tables.map((table) =>
      table === left || table === right
        ? { ...table, deleted: true, deletedAt: time, deletedReason: `merged into ${merged.name}` }
        : table,
    );
    tables.push(merged);
    events.push(`${left.name} + ${right.name} → ${merged.name}`);
  }

  return { sstables: tables, events };
}

function simulateUntil(step, cfg) {
  let mem = new Map();
  let wal = [];
  let sstables = [];
  let nextSSTableIndex = 0;
  let lastRead = null;
  let events = [];

  for (let t = 0; t < step; t += 1) {
    const op = DEFAULT_OPS[t];
    events = [];

    if (op.type === 'set' || op.type === 'del') {
      const entry = {
        key: op.key,
        value: op.type === 'del' ? TOMBSTONE : op.value,
        time: t,
        type: op.type,
      };
      wal.push(entry);
      touchMemEntry(mem, entry, t);
      events.push(`${op.type} ${op.key}`);

      const evicted = evictLRUFromMemtable(mem, sstables, cfg, t, nextSSTableIndex);
      mem = evicted.mem;
      sstables = evicted.sstables;
      nextSSTableIndex = evicted.nextSSTableIndex;
      events.push(...evicted.events);

      if (wal.length >= cfg.walSize) {
        const flushedWal = flushEntries(wal, sstables, cfg, t, 'WAL flush', nextSSTableIndex);
        sstables = flushedWal.sstables;
        if (flushedWal.event) {
          events.push(flushedWal.event);
          nextSSTableIndex += 1;
        }
        wal = [];
        events.push('WAL flushed to SSTable and cleared; MemTable remains unchanged');
      }

      const compacted = compact(sstables, cfg, t);
      if (compacted.events.length) {
        sstables = compacted.sstables;
        events.push(...compacted.events);
      }
    }

    if (op.type === 'get') {
      const trace = [];
      let found = null;
      if (mem.has(op.key)) {
        const hit = mem.get(op.key);
        touchMemEntry(mem, hit, t);
        trace.push('MemTable hit; entry becomes most recently used');
        found = hit.value === TOMBSTONE ? null : hit.value;
      } else {
        trace.push('MemTable miss');
        for (const table of sstables.filter((sstable) => !sstable.deleted).slice().reverse()) {
          if (!maybeInBloom(table.bloom, op.key, cfg.hashes)) {
            trace.push(`${table.name}: Bloom says no`);
            continue;
          }
          const hit = table.entries.find((entry) => entry.key === op.key);
          if (hit) {
            trace.push(`${table.name}: SSTable hit`);
            found = hit.value === TOMBSTONE ? null : hit.value;
            break;
          }
          trace.push(`${table.name}: Bloom false positive`);
        }
      }
      lastRead = { time: t, key: op.key, value: found, trace };
      events.push(`get ${op.key}`);
    }
  }

  return { mem: Array.from(mem.values()), wal, sstables, lastRead, events };
}

function describeNextStep(step, cfg) {
  if (step >= DEFAULT_OPS.length) return 'Simulation is complete.';

  const before = simulateUntil(step, cfg);
  const after = simulateUntil(step + 1, cfg);
  const op = DEFAULT_OPS[step];
  const lines = [];

  if (op.type === 'set') {
    lines.push(`Next: write key '${op.key}' with value ${op.value}.`);
    lines.push('It will be appended to the WAL and placed/updated in the MemTable as the most recently used entry.');
  } else if (op.type === 'del') {
    lines.push(`Next: delete key '${op.key}' by writing a tombstone.`);
    lines.push('The tombstone will be appended to the WAL and placed/updated in the MemTable as the most recently used entry.');
  } else {
    lines.push(`Next: read key '${op.key}'.`);
    lines.push('Lookup will check the MemTable first, then active SSTables using Bloom filters.');
  }

  const created = after.sstables.filter((next) => !before.sstables.some((prev) => prev.name === next.name));
  const deleted = after.sstables.filter(
    (next) => next.deleted && !before.sstables.some((prev) => prev.name === next.name && prev.deleted),
  );
  const read = after.lastRead && after.lastRead.time === step ? after.lastRead : null;

  if (created.some((table) => table.reason === 'WAL flush')) {
    lines.push('The WAL will reach its max size, so the WAL entries will be flushed into a new SSTable. The MemTable will remain unchanged.');
  }
  if (created.some((table) => table.reason === 'LRU eviction from MemTable')) {
    const evictedKeys = created
      .filter((table) => table.reason === 'LRU eviction from MemTable')
      .flatMap((table) => table.entries.map((entry) => entry.key))
      .join(', ');
    lines.push(`The MemTable will exceed its max size, so the least-recently-used entry (${evictedKeys}) will be evicted to disk. The rest of the MemTable will stay intact.`);
  }
  created.forEach((table) => lines.push(`Create ${table.name}.`));
  deleted.forEach((table) => lines.push(`Mark ${table.name} as deleted/faded because it was ${table.deletedReason}.`));
  if (read) lines.push(`Result will be: ${read.value ?? 'not found'}. Trace: ${read.trace.join(' → ')}.`);

  return lines.join(' ');
}

function NumberSetting({ label, help, value, min, max, onChange }) {
  return (
    <label className="setting-row">
      <div className="setting-header">
        <span>{label}</span>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          onChange={(event) => onChange(Math.max(min, Math.min(max, Number(event.target.value) || min)))}
        />
      </div>
      <p>{help}</p>
    </label>
  );
}

function Panel({ title, subtitle, children }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>{title}</h2>
        {subtitle ? <span>{subtitle}</span> : null}
      </div>
      {children}
    </section>
  );
}

function KVTable({ rows, showType = false, empty = 'empty' }) {
  if (!rows.length) return <p className="empty-state">{empty}</p>;

  return (
    <table className="kv-table">
      <thead>
        <tr>
          <th>Key</th>
          <th>Value</th>
          <th>Time</th>
          {showType ? <th>Action</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={`${row.key}-${row.time}-${index}`} className={row.value === TOMBSTONE ? 'deleted-row' : ''}>
            <td>{row.key}</td>
            <td>{row.value}</td>
            <td>{row.time}</td>
            {showType ? <td>{row.type}</td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OperationTable({ step }) {
  return (
    <table className="kv-table operations-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Action</th>
          <th>Key</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        {DEFAULT_OPS.map((op, index) => {
          const current = index === step;
          const done = index < step;
          return (
            <tr key={index} className={current ? 'current-op' : done ? 'done-op' : ''}>
              <td>{index}</td>
              <td>{op.type}</td>
              <td>{op.key}</td>
              <td>{op.value || ''}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Bloom({ bits }) {
  return (
    <div className="bloom-grid">
      {bits.map((bit, index) => (
        <div key={index} className="bloom-cell-wrap">
          <div className="bloom-index">{index}</div>
          <div className={`bloom-cell ${bit ? 'on' : ''}`}>{bit}</div>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [cfg, setCfg] = useState({
    memtableSize: 5,
    walSize: 3,
    blockSize: 64,
    bloomSize: 24,
    hashes: 3,
    compactionThreshold: 2,
  });
  const [step, setStep] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [showBloom, setShowBloom] = useState(true);
  const [previewText, setPreviewText] = useState('');

  const state = useMemo(() => simulateUntil(step, cfg), [step, cfg]);
  const activeBloom = state.sstables.find((table) => !table.deleted)?.bloom || Array(cfg.bloomSize).fill(0);
  const sstableLevels = useMemo(() => {
    const byLevel = new Map();
    state.sstables.forEach((table) => {
      if (!byLevel.has(table.level)) byLevel.set(table.level, []);
      byLevel.get(table.level).push(table);
    });

    return Array.from(byLevel.entries())
      .sort(([levelA], [levelB]) => levelA - levelB)
      .map(([level, tables]) => ({
        level,
        tables: tables.slice().sort((a, b) => a.start - b.start || a.end - b.end || a.createdAt - b.createdAt),
      }));
  }, [state.sstables]);

  const changeCfg = (key, value) => {
    setCfg((current) => ({ ...current, [key]: value }));
    setStep(0);
    setPreviewText('');
  };

  const resetSimulation = () => {
    setStep(0);
    setPreviewText('');
  };

  const goStart = () => resetSimulation();
  const goBack = () => {
    setStep((current) => Math.max(0, current - 1));
    setPreviewText('');
  };
  const goEnd = () => {
    setStep(DEFAULT_OPS.length);
    setPreviewText('');
  };
  const nextStep = () => {
    if (step >= DEFAULT_OPS.length) return;
    if (!previewText) {
      setPreviewText(describeNextStep(step, cfg));
      return;
    }
    setStep((current) => Math.min(DEFAULT_OPS.length, current + 1));
    setPreviewText('');
  };

  return (
    <div className="app-shell">
      <div className="layout">
        <aside className="left-rail">
        {settingsOpen ? (
          <div className="settings-panel">
            <div className="settings-title">
              <div><Settings size={18} /> Settings</div>
              <button onClick={() => setSettingsOpen(false)}>close</button>
            </div>
            <NumberSetting
              label="memtableSize"
              value={cfg.memtableSize}
              min={2}
              max={12}
              onChange={(value) => changeCfg('memtableSize', value)}
              help="Maximum number of entries kept in the MemTable. When it exceeds this size, only the least-recently-used entry is evicted to an SSTable."
            />
            <NumberSetting
              label="walSize"
              value={cfg.walSize}
              min={1}
              max={10}
              onChange={(value) => changeCfg('walSize', value)}
              help="Maximum number of WAL entries before those WAL entries are written to a new SSTable. The MemTable is not cleared by this."
            />
            <NumberSetting
              label="blockSize"
              value={cfg.blockSize}
              min={16}
              max={512}
              onChange={(value) => changeCfg('blockSize', value)}
              help="Block size in bytes shown for disk storage."
            />
            <NumberSetting
              label="bloom size"
              value={cfg.bloomSize}
              min={8}
              max={48}
              onChange={(value) => changeCfg('bloomSize', value)}
              help="Number of bits in the Bloom filter."
            />
            <NumberSetting
              label="hashes"
              value={cfg.hashes}
              min={1}
              max={6}
              onChange={(value) => changeCfg('hashes', value)}
              help="Number of hash functions used in the Bloom filter."
            />
            <NumberSetting
              label="compactionThreshold"
              value={cfg.compactionThreshold}
              min={2}
              max={8}
              onChange={(value) => changeCfg('compactionThreshold', value)}
              help="Keep this at 2 for pairwise merges: SSTable-0 + SSTable-1 → SSTable0_1."
            />
          </div>
        ) : (
          <button className="open-settings" onClick={() => setSettingsOpen(true)}><Settings size={18} /></button>
        )}

          <Panel title="Operations">
            <div className="operations-scroll"><OperationTable step={step} /></div>
          </Panel>
        </aside>

        <main className="main-content">
          <div className="toolbar panel">
            <div className="toolbar-row">
              <div className="button-group">
                <button onClick={goStart}><ChevronsLeft size={16} /></button>
                <button onClick={goBack}><ChevronLeft size={16} /></button>
                <button className={previewText ? 'preview-active' : ''} onClick={nextStep}><ChevronRight size={16} /></button>
                <button onClick={goEnd}><ChevronsRight size={16} /></button>
              </div>
              <div className="step-counter">step {step} / {DEFAULT_OPS.length}</div>
              <div className="button-group right-actions">
                <button onClick={() => setShowBloom((current) => !current)}>
                  {showBloom ? <EyeOff size={16} /> : <Eye size={16} />}
                  {showBloom ? 'hide Bloom Filter' : 'show Bloom Filter'}
                </button>
                <button onClick={resetSimulation}><RotateCcw size={16} /> reset</button>
              </div>
            </div>

            {previewText ? (
              <div className="preview-box">
                <b>Preview:</b> {previewText}
                <div>Press next again to execute this step.</div>
              </div>
            ) : null}

            {state.lastRead ? (
              <div className="read-box">
                GET {state.lastRead.key} → <b>{state.lastRead.value ?? 'not found'}</b>
                <span>{state.lastRead.trace.join(' · ')}</span>
              </div>
            ) : null}
          </div>

          {showBloom ? (
            <Panel title="Bloom Filter" subtitle={`latest active SSTable · size ${cfg.bloomSize}`}>
              <Bloom bits={activeBloom} />
            </Panel>
          ) : null}

          <div className="two-column">
            <Panel title="MemTable" subtitle={`max size: ${cfg.memtableSize} · LRU → MRU`}>
              <KVTable rows={state.mem} empty="MemTable is empty" />
            </Panel>
            <Panel title="Write Ahead Log (WAL)" subtitle={`max size: ${cfg.walSize}`}>
              <KVTable rows={state.wal} showType empty="WAL is empty" />
            </Panel>
          </div>

          <Panel title="SSTables on Disk" subtitle={`block size: ${cfg.blockSize} bytes`}>
            {state.sstables.length ? (
              <div className="level-stack">
                {sstableLevels.map(({ level, tables }) => (
                  <div key={level} className="sstable-level">
                    <div className="level-title">Level {level}</div>
                    <div className="sstable-row">
                      {tables.map((table) => (
                        <div key={table.id} className={`sstable-card ${table.deleted ? 'faded' : ''}`}>
                          <div className="sstable-header">
                            <span>{table.name}</span>
                            <span>{table.deleted ? `deleted t=${table.deletedAt}` : `created t=${table.createdAt}`}</span>
                          </div>
                          <div className="sstable-reason">{table.deleted ? table.deletedReason : table.reason}</div>
                          <KVTable rows={table.entries} empty="no entries" />
                          {showBloom ? <div className="mini-bloom"><Bloom bits={table.bloom} /></div> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty-state">No SSTables yet</p>
            )}
          </Panel>
        </main>
      </div>
    </div>
  );
}
