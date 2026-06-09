[English](README.md) | [Русский](README.ru.md)

---

<p align="center">
  <img src="https://exploredata.pro/wp-content/uploads/logo/logo_270x270.png" height="30" alt="ExploreData logo" />&nbsp;&nbsp;2.	<h1 align="center">OMaX</h1>
</p>

<p align="center">Excel client for <a href="https://optimacros.com">Optimacros</a></p>

---

## Overview

OMaX is a Microsoft Excel add-in that empowers users to build reports, perform ad-hoc analysis, and update data using real-time Optimacros snapshots. The tool is favored by finance and accounting users who are comfortable with Microsoft Excel and frequently interact with Optimacros data.

Current version capabilities:

- Build view snapshots from Optimacros, rearrange (pivot) dimensions, and drill down or drill up through data
- Edit data and save changes back to the server
- Hide empty rows in the report
- Expand hierarchical dimensions into levels and use them as regular PivotTable dimensions

## Requirements

| Component | Version |
|---|---|
| Microsoft Excel (Windows desktop) | 2013+ |
| Optimacros | Any version with a Script web service endpoint |

> macOS Excel is not supported.

## Repository Contents

| File | Description |
|---|---|
| `OMaX.xlsm` | Main client workbook |
| `REST API Gateway.js` | Optimacros script: validates and dispatches incoming HTTP requests |
| `REST API Data Service.js` | Optimacros script: reads/writes data from multicubes and lists |

## Setup

### Server side

In your Optimacros model, open **Scripts** and create two scripts from the files in this repository:

- `REST API Gateway.js`
- `REST API Data Service.js`

In the **Admin Panel -> API Services**, create a new web service Endpoint and assign `REST API Gateway.js` to it.

### Client side

1. Open `OMaX.xlsm` in Excel. Enable macros and Data Model / Power Pivot when prompted.
2. On the **Connection** sheet, enter the Endpoint URL and your Optimacros credentials as described in the field hints.
3. Click **Check Connection** to verify the link.
4. On the first connection to the Optimacros server, OMaX will prompt you to approve web content access for the Endpoint. Leave the connection type as **Anonymous** and click **Connect**.
5. Click **Load Model** to load Lists and Multicubes.

## Usage

### DataPivot — View Mode

| Button | Action |
|---|---|
| **Load Data** | Fetches data for the selected multicube view from Optimacros |
| **Build Pivot** | Builds or refreshes the OLAP PivotTable from loaded data |
| **Sort** | Sorts dimension members according to their order in the Optimacros source |
| **Edit Data** | Activates Edit Mode |
| **Hide Empty / Show Empty** | Toggles display of empty rows and columns in the PivotTable |
| **Show Formulas / Hide Formulas** | Toggles visibility of Notes (cube formulas) for PivotTable cells |
| **Tabular View / Outline View** | Switches the PivotTable layout mode |

> Double-clicking a PivotTable cell also activates Edit Mode.  
> While in Edit Mode this sheet is protected — data changes, filtering, and sorting are disabled.

### DataPivotEdit — Edit Mode

| Button | Action |
|---|---|
| **Save** | Saves modified values to the Optimacros server |
| **Cancel** | Exits Edit Mode with confirmation; discards all unsaved changes |
| **Reset** | Reloads data from DataPivot, discarding all unsaved changes |

> Modified cells are highlighted automatically via Conditional Formatting.

## License

[GPL-3.0](LICENSE)
