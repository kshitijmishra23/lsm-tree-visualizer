# LSM Tree Simulation

An interactive React simulation of an LSM-tree style storage engine. It visualizes writes, reads, the Write-Ahead Log, MemTable, SSTables, Bloom filters, tombstones, LRU-based MemTable eviction, and pairwise SSTable merging.

## Features

- Step-by-step simulation with a preview-before-execute interaction.
- WAL entries are flushed into SSTables when the WAL threshold is reached.
- MemTable uses LRU behavior instead of being fully cleared when it reaches capacity.
- SSTable data is sorted by key in ascending order and deduplicated.
- SSTable names follow this pattern:
  - `SSTable-0`, `SSTable-1`, `SSTable-2`, ...
  - `SSTable-0 + SSTable-1 -> SSTable0_1`
  - `SSTable-2 + SSTable-3 -> SSTable2_3`
  - `SSTable0_1 + SSTable2_3 -> SSTable0_3`
- Deleted/merged SSTables remain visible but faded.
- SSTables are displayed level-wise:
  - Level 0: `SSTable-0`, `SSTable-1`, `SSTable-2`, ... side-by-side
  - Level 1: `SSTable0_1`, `SSTable2_3`, ... side-by-side
  - Level 2: `SSTable0_3`, ...
- Bloom filter visibility can be toggled.

## Brief: What is an LSM Tree?

An LSM Tree, or Log-Structured Merge Tree, is a storage structure optimized for high write throughput. Instead of immediately updating data on disk in-place, writes are first appended to a Write-Ahead Log and stored in an in-memory sorted structure called a MemTable.

When data is flushed to disk, it is written as an immutable sorted file called an SSTable. Since SSTables are immutable, multiple versions of the same key can exist across different SSTables. During reads, newer data is checked first. Deletes are represented using tombstones, which are special markers indicating that a key has been deleted.

Over time, SSTables are merged through compaction. Compaction removes older duplicate versions, keeps the latest value for each key, and combines smaller SSTables into larger sorted SSTables. Bloom filters are often used to quickly determine whether a key is definitely not present in an SSTable, reducing unnecessary disk lookups.

## Prerequisites

Install Node.js first. Node.js 18 or later is recommended.

Check your installation:

```bash
node -v
npm -v
```

## How to run locally

```bash
npm install
npm run dev
```

Then open the local URL shown in your terminal, usually:

```text
http://localhost:5173
```

## Build for production

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## Project structure

```text
lsm-tree-simulation/
├── README.md
├── index.html
├── package.json
└── src/
    ├── App.css
    ├── App.jsx
    └── main.jsx
```

## Pushing to GitHub

```bash
git init
git add .
git commit -m "Add LSM tree simulation"
git branch -M main
git remote add origin <your-github-repo-url>
git push -u origin main
```

Replace `<your-github-repo-url>` with your repository URL.
