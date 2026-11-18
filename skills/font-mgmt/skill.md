---
name: font-mgmt
description: Manage, extract, compress, audit, and synchronize font collections between zipped-fonts and unzipped-fonts buckets in the Ludvig typography workspace.
---

# Font Management Skill (`font-mgmt`)

Provides governance, bidirectional synchronization, and archive verification for font collections across two canonical storage buckets in `Z:\luxdev\ludvig\fonts`.

## Architecture & Bucket Structure

```
fonts/
├── zipped-fonts/          # Bucket 1: Compressed font packages (.zip)
├── unzipped-fonts/        # Bucket 2: Extracted font packages organized by font family
│   ├── roboto/
│   ├── lemon_milk/
│   └── nevera/
├── hermes-font-suite/     # Interactive preview application
├── skills/
│   └── font-mgmt/
│       ├── skill.md       # Skill definition & runbooks
│       └── scripts/
│           └── zipped-unzipped-sync.py
├── scripts/
│   └── zipped-unzipped-sync.py
├── zipped-unzipped-sync.py
└── agents.md              # Agent directives for font management
```

## Storage Buckets

1. **`./zipped-fonts/`**:
   - Stores master compressed font archives (`.zip`).
   - Every font family must have a corresponding `.zip` file here.
   - Used for lightweight distribution, cold storage, and backup.

2. **`./unzipped-fonts/`**:
   - Stores extracted font directories (`<font_name>/`).
   - Contains direct font binaries (`.otf`, `.ttf`, `.woff`, `.woff2`) and associated license/specimen files.
   - Consumed directly by apps, build tools, web design pipelines, and Figma Make integrations.

---

## Tooling: `zipped-unzipped-sync.py`

Located at:
- `scripts/zipped-unzipped-sync.py`
- `skills/font-mgmt/scripts/zipped-unzipped-sync.py`
- Root `zipped-unzipped-sync.py`

### Commands & Usage

#### 1. Bidirectional Synchronization (Default)
Synchronizes any newly added or modified fonts between both buckets.
```bash
python zipped-unzipped-sync.py
# or
python scripts/zipped-unzipped-sync.py --sync
```
- If a `.zip` exists without an unzipped folder, it is extracted into `unzipped-fonts/<stem>/`.
- If an unzipped folder exists without a `.zip`, it is compressed into `zipped-fonts/<stem>.zip`.

#### 2. Parity & Integrity Verification Gate
Validates that every single font exists in both buckets and tests all zip archives for corruption.
```bash
python zipped-unzipped-sync.py --check
```
Expected output:
```
RESULT: PARITY PASSED (100% synchronized)
```

#### 3. Font Inventory Catalog Report
Generates a tabular catalog of all fonts, file sizes, detected binary formats, and sync statuses.
```bash
python zipped-unzipped-sync.py --report
```

#### 4. Forced Overwrite
Forces complete re-extraction and re-compression regardless of file timestamps:
```bash
python zipped-unzipped-sync.py --force
```

---

## Operating Invariants & Guardrails

1. **Dual-Bucket Parity**: No font is committed or pushed unless it exists in both `./zipped-fonts/` and `./unzipped-fonts/`.
2. **Deterministic Naming**: Folder names in `unzipped-fonts/` match the stem of the `.zip` file in `zipped-fonts/` (e.g., `lemon_milk.zip` <-> `unzipped-fonts/lemon_milk/`).
3. **Archive Integrity**: Archives must pass `zipfile.testzip()` without errors.
4. **Preserve Surrounding Apps**: Do not alter `hermes-font-suite` or application configurations when performing font bucket syncs.
