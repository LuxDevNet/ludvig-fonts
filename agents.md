# Ludvig Fonts Repository (`agents.md`)

Instructions and operating protocols for AI agents and developers working in `Z:\luxdev\ludvig\fonts`.

---

## 1. Repository Purpose & Architecture

This repository is the central typography and font management asset repository for the Ludvig design ecosystem. It maintains font archives and extracts in dual synchronized buckets:

```
Z:\luxdev\ludvig\fonts\
├── zipped-fonts/          # Canonical compressed archives (.zip)
├── unzipped-fonts/        # Canonical extracted font packages (<font_name>/)
├── hermes-font-suite/     # Interactive typography preview & testing application
├── skills/
│   └── font-mgmt/
│       ├── skill.md       # Font management skill instructions
│       └── scripts/
│           └── zipped-unzipped-sync.py
├── scripts/
│   └── zipped-unzipped-sync.py
├── zipped-unzipped-sync.py# Root runner shortcut
└── agents.md              # Agent governance & execution protocol
```

---

## 2. Core Buckets & Storage Rules

### `./zipped-fonts/`
- Contains one compressed `.zip` package per font family (e.g. `roboto.zip`, `lemon_milk.zip`, `nevera.zip`).
- Retains pristine source archives for transport, backup, and external distribution.
- All archives must be valid ZIP files (verified via `zipfile.testzip()`).

### `./unzipped-fonts/`
- Contains one extracted directory per font family named identically to the archive stem (e.g. `./unzipped-fonts/roboto/`).
- Houses the actual font binary files (`.otf`, `.ttf`, `.woff`, `.woff2`) along with licenses, specimens, and metadata.
- Directly consumed by UI projects, Figma Make builds, and font loaders.

---

## 3. Mandatory Parity Invariant

> **INVARIANT**: All fonts MUST exist in BOTH `./zipped-fonts/` AND `./unzipped-fonts/` at all times.

- If you add a new `.zip` archive to `./zipped-fonts/`, you must immediately extract it into `./unzipped-fonts/<font_name>/`.
- If you add a new font folder to `./unzipped-fonts/`, you must immediately compress it into `./zipped-fonts/<font_name>.zip`.
- If you modify or remove a font in one bucket, the other bucket must be updated to match.
- **Never leave loose font binaries at the root of `Z:\luxdev\ludvig\fonts\`.**

---

## 4. Automation & Commands

The repository provides `zipped-unzipped-sync.py` to maintain dual-bucket parity automatically.

### Running Sync & Verification
```powershell
# Bidirectional sync (extracts missing folders, compresses missing zips)
python zipped-unzipped-sync.py

# Parity & integrity check gate (verifies 100% sync and archive validity)
python zipped-unzipped-sync.py --check

# Generate font inventory report (displays sizes, counts, and formats)
python zipped-unzipped-sync.py --report

# Force overwrite (re-extracts and re-compresses all assets)
python zipped-unzipped-sync.py --force
```

### Script Locations
The sync script is accessible from multiple standard entry points:
- Root: `python zipped-unzipped-sync.py`
- Scripts directory: `python scripts/zipped-unzipped-sync.py`
- Skill directory: `python skills/font-mgmt/scripts/zipped-unzipped-sync.py`

---

## 5. Agent Workflow Guidelines

When an agent is requested to add, modify, or inspect fonts:
1. **Pre-Check**: Run `python zipped-unzipped-sync.py --check` to confirm the baseline state.
2. **Execute Action**:
   - Add new fonts into either `./zipped-fonts/` or `./unzipped-fonts/<font_name>/`.
   - Maintain lowercase/snake_case or clean slug directory naming consistent with the repository.
3. **Synchronize**: Run `python zipped-unzipped-sync.py` to mirror changes across buckets.
4. **Verification Gate**: Run `python zipped-unzipped-sync.py --check` and confirm `RESULT: PARITY PASSED (100% synchronized)`.
5. **Preservation**: Do not touch `hermes-font-suite` source code or public assets unless explicitly instructed by the user.
