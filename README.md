<p align="center">
  <img src="https://exploredata.pro/wp-content/uploads/logo/logo_270x270.png" width="96" alt="ExploreData logo" />
</p>

<h1 align="center">OMaX</h1>

<p align="center">
  Excel client for <a href="https://optimacros.com">Optimacros</a>
</p>

---

## Overview

OMaX bridges **Optimacros** (a CPM/planning platform) and **Microsoft Excel** without any add-in installation.

## Requirements

| Component | Minimum version |
|---|---|
| Microsoft Excel (Windows desktop) | 2013 |
| Optimacros | Any version with a Script web service endpoint |

> macOS Excel is not supported.

## Repository Contents

| File | Description |
|---|---|
| `OMaX v0.54.xlsm` | Main client workbook — Power Query + VBA |
| `REST API Gateway 2.2.js` | Optimacros script: validates and dispatches incoming HTTP requests |
| `REST API Data Service.js` | Optimacros script: reads/writes data from multicubes and lists |

## Setup

### Server side

In your Optimacros model, open **Scripts** and create two scripts from the files in this repository:
   - `REST API Gateway 2.2.js` — assign it to a web service **Endpoint**.
   - `REST API Data Service.js` — invoked by the Gateway.

### Client side

1. Open `OMaX v0.54.xlsm` in Excel (enable macros and Data Model / Power Pivot when prompted).
2. On the **Connection** sheet, enter the Endpoint URL and your Optimacros credentials.
3. Click **Check Connection** to verify the link.
4. Click **Load Model** → **Load Data** → **Build Pivot** to load data and render the PivotTable.

## Usage

| Button | Action |
|---|---|
| Check Connection | Verifies the Endpoint and credentials |
| Load Model | Retrieves the list of multicubes and dimensions |
| Load Data | Fetches data for the selected multicube view |
| Build Pivot | Builds or refreshes the OLAP PivotTable |
| Edit Data | Activates writeback mode — edit cells directly in the PivotTable |
| Save Changes | Sends modified values back to Optimacros |

## License

[GPL-3.0](LICENSE)
