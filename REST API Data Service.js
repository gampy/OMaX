// DESCRIPTION: OMaX Server Runtime. Called from REST API Gateway.
// VERSION: 1.3.2 (OMaX 0.62)
// CREATED BY: Alexey Zaitsev
// MODIFIED BY:


/**
 * @typedef {import('../declaration/om').OM} om
 */

 // const { om } = require('../declaration/om');

/**
 * Action types enum
 */
const Action = Object.freeze({
  GET: 'get',
  PUT: 'put',
});


/**
 * Request builder for nested requests.
 * Constructs body object for DataService.performAction().
 */
class Request {

  constructor(body = {}) {
    const {
      action = Action.GET,
      source = {},
      params = {}
    } = body;

    this.action = action;
    this.source = {
      type: source.type || '',
      name: source.name || '',
      view: source.view || '',
      filters: source.filters || {}
    };
    this.params = {
      match: {
        lablesOnly: params.match && params.match.lablesOnly !== undefined ? params.match.lablesOnly : true,
        separator: params.match && params.match.separator !== undefined ? params.match.separator : '||'
      },
      grid: {
        maxCells: params.grid && params.grid.maxCells !== undefined ? params.grid.maxCells : 0
      }
    };
  }

  /**
   * Builds the body object for DataService.performAction()
   * @returns {Object} Request body
   */
  build() {
    const body = {
      source: { ...this.source },
      params: { ...this.params }
    };

    return { [this.action]: body };
  }

  /**
   * Builds and executes the request
   * @returns {Object} Response from DataService.performAction()
   */
  execute() {
    return DataService.performAction(this.build());
  }
}

/**
 * Base class for the data service types.
 */
class DataService {

  /** Source type identifiers. */
  static SourceType = Object.freeze({
    PING:       'PING',
    LISTS:      'LISTS',
    MULTICUBES: 'MULTICUBES',
    VERSIONS:   'VERSIONS',
    TIME:       'TIME',
    LIST:       'LIST',
    MULTICUBE:  'MULTICUBE',
    CUBES:      'CUBES',
  });

  static Scope = {

    Dimensions: class {
      /**
       * @param {DataService} ds
       * @param {{ lists?: boolean }} params
       */
      constructor(ds, params) { this.ds = ds; this.params = params; }

      /**
       * @returns {{ status: string, dimensions: object, rowCount?: number, columnCount?: number, lists?: object }}
       */
      read() {
        const { ds, params } = this;
        if (!ds.grid) return { status: "OK", dimensions: ds.dimensions };
        const response = {
          status: "OK",
          dimensions: ds.dimensions,
          rowCount: ds.grid.rowCount(),
          columnCount: ds.grid.columnCount()
        };
        if (ds instanceof Multicube && params.lists) response.lists = ds.findLists();
        return response;
      }
    },

    Items: class {
      /**
       * @param {DataService} ds
       * @param {{ lablesOnly?: boolean, separator?: string, maxCells?: number, chunkSize?: number, rowCount?: number, rowStart?: number }} params
       */
      constructor(ds, params) { this.ds = ds; this.params = params; }

      /**
       * @returns {{ status: string, items: object, cubes?: object }}
       */
      read() {
        const { ds, params } = this;
        const { lablesOnly, separator, maxCells, chunkSize, rowCount, rowStart } = params;
        const items = {};
        const ordinalCount = {};
        const dimItemsKeys = {};

        // Appends one member to items[dimension], deduped by key.
        const append = (lbl, dim) => {
          const key = ds.makeKey(lbl, separator); // cheap: reads label()/name() off the loaded label
          if (!dimItemsKeys[dim]) dimItemsKeys[dim] = new Set();
          if (!items[dim]) items[dim] = [];
          if (!dimItemsKeys[dim].has(key)) {
            dimItemsKeys[dim].add(key);
            if (!ordinalCount[dim]) ordinalCount[dim] = 0;
            const parent = ds.getKeyById(lbl.parentLongId(), separator); // expensive: only for new keys
            items[dim].push({ key, parent, ordinal: ++ordinalCount[dim] });
            ds.onItemAdded(key, dim);
          }
        };

        try {
          // Page selectors: cross-reference with ds.dimensions.pageSelectors
          const pageSelectorSet = new Set(ds.dimensions.pageSelectors || []);
          ds.grid.getDefinitionInfo().getPageSelectors()
            .filter(d => pageSelectorSet.has(d.getDimensionEntity().name())) // excludes excludeDimensions
            .forEach(pageSelector => {
              const dim = pageSelector.getDimensionEntity().name();
              const selected = pageSelector.getSelectedEntity();
              if (!selected) return;
              const target = lablesOnly ? selected.label() : ds.makeKey(selected, separator);
              if (ds.passesFilter(dim, target)) append(selected, dim);
            });

          // Header-only traversal. Returns true when the group passed all filters
          const collectGroup = (group, dims) => {
            const labels = group.all();
            // A row/column is included only if all of its labels pass the filters.
            for (let i = 0; i < labels.length; i++) {
              if (!ds.passesFilter(dims[i], lablesOnly ? labels[i].label() : ds.makeKey(labels[i], separator))) return false;
            }
            labels.forEach((lbl, i) => append(lbl, dims[i]));
            return true;
          };

          const generator = ds.grid.range(rowStart, rowCount, 0, -1).generator(chunkSize);
          let columnsDone = false;
          // Count only filter-passing columns/rows for the maxCells
          let columnCount = 0;
          let rowsProcessed = 0;

          for (const chunk of generator) {
            const rowGroups = chunk.rows().all();
            const colGroups = chunk.columns().all();

            // Columns are identical across row-band chunks: collect and count once.
            if (!columnsDone && colGroups && colGroups.length > 0) {
              columnCount = colGroups.reduce((count, group) => count + (collectGroup(group, ds.dimensions.columns) ? 1 : 0), 0);
              columnsDone = true;
            }

            if (rowGroups) {
              rowGroups.forEach(group => {
                if (maxCells > 0 && columnCount > 0 && rowsProcessed * columnCount > maxCells) return;
                if (collectGroup(group, ds.dimensions.rows)) rowsProcessed++;
              });
            }
          }

          ds.afterRead();

          const response = { status: "OK", items };
          if (ds.cubes) response.cubes = ds.cubes;
          return response;

        } catch (e) {
          return { status: "ERROR", items };
        }
      }
    },

    Cells: class {
      /**
       * @param {DataService} ds
       * @param {{ lablesOnly?: boolean, separator?: string, maxCells?: number, chunkSize?: number, rowCount?: number, rowStart?: number }} params
       */
      constructor(ds, params) { this.ds = ds; this.params = params; }

      /**
       * @returns {{ status: string, cells: object, message: string }}
       */
      read() {
        const { ds, params } = this;
        const { lablesOnly, separator, maxCells, chunkSize, rowCount, rowStart } = params;
        const cells = {};

        ds.message = "Cells loaded";
        let cellCount = 0;

        try {
          const generator = ds.grid.range(rowStart, rowCount, 0, -1).generator(chunkSize);

          for (const chunk of generator) {
            const axis0Groups = chunk.rows().all();
            const axis1Groups = chunk.columns().all();
            const hasAxis0 = axis0Groups && axis0Groups.length > 0;
            const hasAxis1 = axis1Groups && axis1Groups.length > 0;

            if (!hasAxis0 && !hasAxis1) {
              const cellValue = chunk.cells().all()[0]?.getValue();
              if (cellValue !== undefined) { cells['Value'] = cellValue; cellCount++; }
              continue;
            }

            if (!hasAxis0 && hasAxis1) {
              if (ds.dimensions.rows.length > 0) continue;
              // Columns-only view: treat columns as primary axis.
              const r = ds.traverseCells({
                chunk, axis0Groups: axis1Groups, axis1Groups: null,
                axis0Dimensions: ds.dimensions.columns, axis1Dimensions: null,
                data: cells, lablesOnly, separator, maxCells, cellCount
              });
              cellCount = r.cellCount;
              continue;
            }

            const r = ds.traverseCells({
              chunk, axis0Groups, axis1Groups,
              axis0Dimensions: ds.dimensions.rows, axis1Dimensions: ds.dimensions.columns,
              data: cells, lablesOnly, separator, maxCells, cellCount
            });
            cellCount = r.cellCount;
          }

          ds.afterRead();
          return { status: "OK", cells, message: ds.message };

        } catch (e) {
          return { status: "ERROR", cells, message: String(e.message || e) };
        }
      }
    }

  };

  /**
   * @param {string} type
   * @param {Object<string,string[]>} [filters]
   */
    constructor(type, filters = {}) {
      this.type = type;
      this.filters = filters;
      this.dimensions = { pageSelectors: [], rows: [], columns: [] };
      this.message = "";
      this.errorResponse = null;
      this.useWithoutValues = false;
    }

  /**
   * Performs action based on operation type.
   * @param {object} body - Request body with operation key (get/put)
   * @returns {object} Response object
   */
  static performAction(body) {
    const [action] = Object.keys(body);
    const content = body[action] || {};

    const {
      source: { type, name, view, filters = {} } = {},
      params: {
        match: { lablesOnly = true, separator = "||" } = {},
        grid: {
          maxCells = 5000,
          excludeDimensions = [],
          rowStart = 0,
          rowCount = -1,
          chunkSize = 5000
        } = {},
        lists = false,
        scope = 'Cells' // 'Dimensions', 'Items'
      } = {},
      data = {},
      dimensions = {}
    } = content;

    const ds = DataService.create({
      type, name, view: view || undefined, filters, excludeDimensions,
      withoutValues: scope === 'Items' // header-only scope does not need cell values loaded
    });
    if (ds.errorResponse) return ds.errorResponse;

    switch (action) {
      case Action.GET: {
        const ping = ds.respond();
        if (ping) return ping;

        const Reader = DataService.Scope[scope];
        if (!Reader) return { status: "ERROR", message: `Unsupported scope: "${scope}"` };

        return new Reader(ds, {
          lablesOnly, separator, maxCells, chunkSize, rowCount, rowStart, lists
        }).read();
      }

      case Action.PUT:
        return ds.write(data, dimensions, separator);

      default:
        return { status: "ERROR", message: `Unsupported action: ${action}` };
    }
  }
  
  /**
   * Factory: instantiate the right subclass by type.
   * @param {Object} options
   * @param {string} options.type       - One of DataService.SourceType values
   * @param {string} [options.name]     - Name of the multicube or list (if applicable)
   * @param {string} [options.view]     - Name of the view (for LIST and MULTICUBE)
   * @param {Object<string,string[]>} [options.filters] - Filters to apply to the data
   * @param {string[]} [options.excludeDimensions] - Dimension names to exclude from page selectors / rows / columns
   * @param {boolean} [options.withoutValues] - Apply pivot.withoutValues() (items scope)
   */
  static create({ type, name, view, filters, excludeDimensions = [], withoutValues = false }) {
    let ds;
    const ST = DataService.SourceType;
    switch (type) {
      case ST.PING:       ds = new Ping(type); break;
      case ST.LISTS:      ds = new Lists(type, filters); break;
      case ST.MULTICUBES: ds = new Multicubes(type, filters); break;
      case ST.VERSIONS:   ds = new Versions(type, filters); break;
      case ST.TIME:       ds = new Time(type, name, filters); break;
      case ST.LIST:       ds = new List(type, name, view, filters); break;
      case ST.MULTICUBE:  ds = new Multicube(type, name, view, filters); break;
      case ST.CUBES:      ds = new Cubes(type, name, filters); break;
      default:
        ds = new DataService(type);
        ds.errorResponse = { status: "ERROR", data: {}, message: `Unsupported source type "${type}"` };
        return ds;
    }
    ds.excludeDimensions = new Set(excludeDimensions);
    ds.useWithoutValues = withoutValues;
    try {
      ds.grid = ds.grid();
      if (ds.grid !== undefined && ds.grid !== null) {
        ds.dimensions = ds.getDimensionNames();
      }
    } catch (e) {
      ds.errorResponse = { status: "ERROR", data: {}, message: String(e.message || e) };
    }
    return ds;
  }
  
  /**
   * Return a pivot‐grid object for the source.
   * @abstract
   */
  grid() {
    throw new Error('grid() must be implemented by subclasses');
  }

  /**
   * Applies pivot.withoutValues() when the items scope requested header-only loading.
   * @param {object} pivot
   * @returns {object}
   */
  withoutValues(pivot) {
    return this.useWithoutValues ? pivot.withoutValues() : pivot;
  }

  /**
   * Applies columnsFilter to a Pivot builder if filters contain the given column dimension.
   * @param {Pivot} pivot - Pivot builder
   * @param {string} colDimension - Column dimension name to check in this.filters
   * @returns {Pivot}
   */
  applyColumnsFilter(pivot, colDimension) {
    const values = this.filters[colDimension];
    return values?.length ? pivot.columnsFilter(values) : pivot;
  }

  /**
   * Retrieves the name associated with the specified long ID.
   *
   * @param {string} longId
   * @param {string} separator
   * @returns {string | null} The name corresponding to the long ID, or null if not found.
   */
  getKeyById(longId, separator = "||") {
    try {
      const name = om.common.entitiesInfo().get(longId).name();
      const label = om.common.entitiesInfo().get(longId).label();
      return (label === name) ? label : label + separator + name;
    } catch (e) {
      return null;    
    }
  }

  /**
   * Retrieves the page selector, row, column dimension names.
   * @returns {{ pageSelectors: string[], rows: string[], columns: string[] }}
   */
    getDimensionNames() {
      const definitions = this.grid.getDefinitionInfo();
      const exclude = this.excludeDimensions || new Set();
      const pageSelectors = definitions.getPageSelectors().filter(d => !exclude.has(d.getDimensionEntity().name())).map(d => d.getDimensionEntity().name());
      const rows = definitions.getRowDimensions().filter(d => !exclude.has(d.getDimensionEntity().name())).map(d => d.getDimensionEntity().name());
      const columns = definitions.getColumnDimensions().filter(d => !exclude.has(d.getDimensionEntity().name())).map(d => d.getDimensionEntity().name());
      return { pageSelectors, rows, columns };
    }

  /**
   * Validates that JSON dimensions match the grid dimensions (sets must be identical).
   * @param {{ pageSelectors?: string[], rows: string[], columns: string[] }} jsonDimensions
   * @returns {boolean}
   */
  validateDimensions(jsonDimensions) {
    const jsonSet = new Set([
      ...(jsonDimensions.pageSelectors || []),
      ...(jsonDimensions.rows || []),
      ...(jsonDimensions.columns || []),
    ]);
    const gridSet = new Set([
      ...(this.dimensions.pageSelectors || []),
      ...this.dimensions.rows,
      ...this.dimensions.columns,
    ]);

    if (jsonSet.size !== gridSet.size || ![...jsonSet].every(d => gridSet.has(d))) {
      this.message = `View dimensions mismatch: client [${[...jsonSet].join(", ")}] vs server [${[...gridSet].join(", ")}]`;
      return false;
    }
    return true;
  }

  /**
   * Creates unique key from label (label||name if different, otherwise just label).
   * @param {object} lbl - Label object with label() and name() methods
   * @param {string} separator
   * @returns {string}
   */
  makeKey(lbl, separator = "||") {
    return (lbl.label() === lbl.name()) ? lbl.label() : lbl.label() + separator + lbl.name();
  }

  /**
   * Returns true when the given target passes the filter for the dimension, or when no filter is configured for that dimension.
   * @param {string} dim
   * @param {string} target
   * @returns {boolean}
   */
  passesFilter(dim, target) {
    const allowed = this.filters[dim];
    return !allowed?.length || allowed.includes(target);
  }

  /**
   * Hook: called by Items/Cells scope readers when each label is added.
   * Override in subclasses to collect subtype-specific metadata.
   * @param {string} key
   * @param {string} dimension
   */
  onItemAdded(key, dimension) {}

  /**
   * Hook: called by scope readers after traversal completes.
   * Override in subclasses to perform post-traversal enrichment
   */
  afterRead() {}

  /**
   * Hook: called by performAction before scope dispatch.
   * Return a non-null response object to bypass scope dispatch entirely.
   * Override in subclasses that handle GET requests without a grid traversal.
   * @returns {object|null}
   */
  respond() { return null; }

  /**
   * Builds MDX-style key from array of element keys: [Key1].[Key2].[Key3]
   * @param {string[]} keys
   * @returns {string}
   */
  makeMdxKey(keys) {
    return keys.map(k => `[${k}]`).join('.');
  }

  /**
   * Builds map of MDX-keys to values from nested JSON data for O(1) lookup.
   * @param {object} data - Nested JSON data
   * @param {number} depth - Total nesting depth (number of dimensions)
   * @returns {Map<string, any>} - Map: MDX-key -> value
   */
  buildJsonIndex(data, depth) {
    const index = new Map();
    
    const recurse = (obj, path, level) => {
      if (level === depth) {
        index.set(this.makeMdxKey(path), obj);
        return;
      }
      for (const [key, val] of Object.entries(obj)) {
        recurse(val, [...path, key], level + 1);
      }
    };
    
    recurse(data, [], 0);
    return index;
  }

  /**
   * Writes data to the grid from JSON.
   * @param {object} data - Nested JSON data matching grid dimensions
   * @param {{ pageSelectors?: string[], rows: string[], columns: string[] }} dimensions - Dimensions from request
   * @param {string} separator - Separator for label||name keys
   * @returns {{ status: string, data: { updated: number }, message: string }}
   */
  write(data, dimensions, separator = "||", chunkSize = 5000, rowCount = 5000) {
    if (!this.validateDimensions(dimensions)) {
      return { status: "ERROR", data: { updated: 0 }, message: this.message };
    }

    try {
      const jsonDims = [...dimensions.rows, ...dimensions.columns];
      const jsonIndex = this.buildJsonIndex(data, jsonDims.length);
      const cellBuffer = om.common.createCellBuffer().canLoadCellsValues(false);
      
      // Helper: bind makeKey with separator
      const makeKey = (lbl) => this.makeKey(lbl, separator);

      // Helper: build MDX key aligned to JSON dimension order (handles dimension swaps)
      const buildModifiedMdxKey = (rowKeys, colKeys) => {
        const keysByDim = {};
        this.dimensions.rows.forEach((dim, i) => { keysByDim[dim] = rowKeys[i]; });
        this.dimensions.columns.forEach((dim, i) => { keysByDim[dim] = colKeys[i]; });
        const orderedKeys = jsonDims.map(dim => keysByDim[dim]);
        return this.makeMdxKey(orderedKeys);
      };

      const generator = this.grid.range(0, rowCount, 0, -1).generator(chunkSize);

      for (const chunk of generator) {
        const rowGroups = chunk.rows().all();
        const colGroups = chunk.columns().all();
        const hasRows = rowGroups && rowGroups.length > 0;
        const hasCols = colGroups && colGroups.length > 0;

        if (!hasRows && !hasCols) {
           // Single cell view: no axes on rows and columns
          const cell = chunk.cells().all()[0];
          const cellValue = data['Value'];
          if (cell && cellValue !== undefined) {
            cellBuffer.set(cell, cellValue);
          }
          continue;
        }

        if (!hasRows && hasCols) {
          // Columns only (no rows)
          const cells = chunk.cells().all();
          colGroups.forEach((colGroup, colIdx) => {
            const colKeys = colGroup.all().map(lbl => makeKey(lbl));
            const mdxKey = buildModifiedMdxKey([], colKeys);
            if (jsonIndex.has(mdxKey)) {
              cellBuffer.set(cells[colIdx], jsonIndex.get(mdxKey));
            }
          });
          continue;
        }

         // Standard view: rows and columns
        for (const rowGroup of rowGroups) {
          const rowKeys = rowGroup.all().map(lbl => makeKey(lbl));
          const cells = rowGroup.cells().all();

          cells.forEach((cell, colIdx) => {
            const colGroup = colGroups[colIdx];
            const colKeys = colGroup ? colGroup.all().map(lbl => makeKey(lbl)) : [];
            const mdxKey = buildModifiedMdxKey(rowKeys, colKeys);
            
            if (jsonIndex.has(mdxKey)) {
              cellBuffer.set(cell, jsonIndex.get(mdxKey));
            }
          });
        }
      }

      const cellCount = cellBuffer.count();
      if (cellCount > 0) {
        cellBuffer.apply();
        this.message = "Data saved";
      } else {
        this.message = "No data to save";
      }

      return { 
        status: "OK",
        data: { updated: cellCount },
        message: this.message
      };

    } catch (e) {
      this.message = String(e.message || e);
      return {
        status: "ERROR",
        data: { updated: 0 },
        message: this.message
      };
    }
  }

  /**
   * Process view data for reading with configurable axes
   * @private
   * @param {Object} config
   * @returns {{ cellCount: number }}
   */
  traverseCells(config) {
    const {
      chunk,
      axis0Groups,
      axis1Groups,
      axis0Dimensions,
      axis1Dimensions,
      data,
      lablesOnly,
      separator,
      maxCells,
      cellCount: initialCellCount,
    } = config;

    const makeKey = (lbl) => this.makeKey(lbl, separator);
    
    let cellCount = initialCellCount;
    
    // Pre-collect axis1 labels if exists
    const axis1Labels = axis1Groups ? axis1Groups.map(labelsGroup =>
      labelsGroup.all().map(lbl => ({
        key: makeKey(lbl),
        label: lbl.label(),
        parent: this.getKeyById(lbl.parentLongId(), separator),
      }))
    ) : null;
    
    // Iterate axis0 groups (primary axis)
    axis0Groups.forEach(axis0Group => {
      if (maxCells > 0 && cellCount > maxCells) {
        this.message = `Cell limit of ${maxCells} exceeded. Data truncated`;
        return;
      }
      
      let skip = false;
      let axis0Cursor = data;
      let lastAxis0Parent = null;
      let lastAxis0Key = null;
      
      // Process axis0 hierarchy
      for (const [pos, lbl] of axis0Group.all().entries()) {
        const key = makeKey(lbl);
        const label = lbl.label();
        
        const matchTarget = lablesOnly ? label : key;
        if (!this.passesFilter(axis0Dimensions[pos], matchTarget)) {
          skip = true;
          break;
        }
        
        if (!(key in axis0Cursor)) axis0Cursor[key] = {};
        lastAxis0Parent = axis0Cursor;
        lastAxis0Key = key;
        axis0Cursor = axis0Cursor[key];
      }
      
      if (skip) return;
      
      // Process cells with axis1 (secondary axis) if exists
      const cells = axis0Group.cells ? axis0Group.cells().all() : chunk.cells().all();
      
      cells.forEach((cell, pos) => {
        const thisAxis1Labels = axis1Labels ? axis1Labels[pos] : null;
        
        // 1D view: no axis1 labels
        if (!thisAxis1Labels || thisAxis1Labels.length === 0) {
          if (lastAxis0Parent && lastAxis0Key !== null) {
            lastAxis0Parent[lastAxis0Key] = cell.getValue();
            cellCount++;
          }
          return;
        }
        
        let skip = false;
        let axis1Cursor = axis0Cursor;
        
        // Process axis1 hierarchy (all except last)
        for (let i = 0; i < thisAxis1Labels.length - 1; i++) {
          const { key, label, parent } = thisAxis1Labels[i];
          
          const matchTarget = lablesOnly ? label : key;
          if (!this.passesFilter(axis1Dimensions[i], matchTarget)) {
            skip = true;
            break;
          }
          
          if (!(key in axis1Cursor)) axis1Cursor[key] = {};
          axis1Cursor = axis1Cursor[key];
        }
        
        if (skip) return;
        
        // Process axis1 leaf
        const leaf = thisAxis1Labels[thisAxis1Labels.length - 1];
        const matchTarget = lablesOnly ? leaf.label : leaf.key;
        if (!this.passesFilter(axis1Dimensions[thisAxis1Labels.length - 1], matchTarget)) {
          return;
        }
        
        axis1Cursor[leaf.key] = cell.getValue();
        cellCount++;
      });
    });
    
    return { cellCount };
  }

/**
 * Finds the real lists among dimension names and assigns them to this.lists.{pageSelectors, rows, columns}
 */
  findLists() {
    if (!this.dimensions) return;

    // single shared Set across rows/columns (lazy)
    let allLists = null;
    const ensureAllLists = () => {
      if (!allLists) {
        allLists = DimensionLookup.getAllListNames(); // Set<string>
      }
    };

    const resolveDimension = (namesArr) => {
      const result = [];

      for (const dimName of namesArr) {
        // Versions or reserved names?
        if (["Versions", "Version All", "Version Property", "Time Tree", "Time Tree Property", "Entity", "Property", "Hierarchy Property", "Multicube Property"].includes(dimName)) {
          result.push(dimName);
          continue;
        }

        // Time?
        if (DimensionLookup.TIME_LISTS.includes(dimName)) {
          result.push(dimName)
          continue;
        }

        // List?
        ensureAllLists();
        if (allLists.has(dimName)) {
          result.push(dimName);
          continue;
        }

        // Subset under Versions?
        if (DimensionLookup.hasSubset('Versions', dimName)) {
          result.push('Versions');
          continue;
        }

        // Subset under Time?
        let matchedTime = false;
        for (const time of DimensionLookup.TIME_LISTS) {
          if (DimensionLookup.hasSubset(time, dimName)) {
            result.push(time);
            matchedTime = true;
            break;
          }
        }
        if (matchedTime) continue;

        // Subset under any List?
        let matchedOther = false;
        for (const listName of allLists) {
          if (DimensionLookup.hasSubset(listName, dimName)) {
            result.push(listName);
            matchedOther = true;
            break;
          }
        }
        if (matchedOther) continue;

      // Fallback
        result.push(dimName); 
      }

      return result;
    };

    return {
      rows:    resolveDimension(this.dimensions.rows    || []),
      columns: resolveDimension(this.dimensions.columns || []),
      pageSelectors: resolveDimension(this.dimensions.pageSelectors || []),
    };
  }
}

 /**
 * All lists at once
 */
class Ping extends DataService {
  /**
   * @param {string} type - PING
   */
  constructor(type) {
    super(type);
  }

  grid() {
    return undefined;
  }

  respond() {
    return {
      user: om.common.userInfo().getFirstName() + " " + om.common.userInfo().getLastName(),
      email: om.common.userInfo().getEmail(),
      name: om.common.modelinfo().name(),
      message: "Connected successfully"
    };
  }
}

/**
 * All lists at once
 */
class Lists extends DataService {
  /**
   * @param {string} type - LISTS
   * @param {Object<string,string[]>} [filters] - Filters
   */
  constructor(type, filters) {
    super(type, filters);
  }

  grid() {
    const pivot = om.lists.listsTab().pivot();
    return this.applyColumnsFilter(pivot, 'Hierarchy Property').create();
  }
}

/**
 * All multicubes at once
 */
class Multicubes extends DataService {
  /**
   * @param {string} type  - MULTICUBES
   * @param {Object<string,string[]>} [filters] - Filters
   */
  constructor(type, filters) {
    super(type, filters);
  }

  grid() {
    const pivot = om.multicubes.multicubesTab().pivot();
    return this.applyColumnsFilter(pivot, 'Multicube Property').create();
  }
}

/**
 * Versions
 */
class Versions extends DataService {
  /**
   * @param {string} type  - VERSIONS
   * @param {Object<string,string[]>} [filters] - Filters
   */
  constructor(type, filters) {
    super(type, filters);
  }

  grid() {
    const pivot = om.versions.versionsTab().pivot();
    return this.applyColumnsFilter(pivot, 'Version Property').create();
  }

  subsetGrid() {
    return om.versions
      .versionSubsetsTab()
      .pivot()
      .create();
  }
}

/**
 * Versions
 */
class Time extends DataService {
  /**
   * @param {string} type  - TIME
   * @param {string} name  - Time period name
   * @param {Object<string,string[]>} [filters] - Filters
   */

  constructor(type, name, filters) {
    super(type, filters);
    this.name = name;
  }

  grid() {
    const pivot = om.times.timePeriodTab(this.name).pivot();
    return this.applyColumnsFilter(pivot, 'Time Tree Property').create();
  }

  subsetGrid() {
    return om.times
      .timePeriodTab(this.name)
      .subsetsTab()
      .pivot()
      .create();
  }
}

/**
 * A single list
 */
class List extends DataService {
  /**
   * @param {string} type  - LIST
   * @param {string} name  - List name
   * @param {string} [view]  - View name
   * @param {Object<string,string[]>} [filters] - Filters
   */

  constructor(type, name, view = undefined, filters) {
    super(type, filters);
    this.name = name;
    this.view = view;
  }

  grid() {
    const pivot = om.lists.listsTab().open(this.name).pivot(this.view);
    return this.applyColumnsFilter(this.withoutValues(pivot), 'Property').create();
  }

  subsetGrid() {
    return om.lists
      .listsTab()
      .open(this.name)
      .listSubsetTab()
      .pivot()
      .create();
  }
}

/**
 * A single multicube
 */
class Multicube extends DataService {
  /**
   * @param {string} type  - MULTICUBE
   * @param {string} name  - Multicube name
   * @param {string} [view]  - View name
   * @param {Object<string,string[]>} [filters] - Filters
   */
  constructor(type, name, view = undefined, filters) {
    super(type, filters);
    this.name = name;
    this.view = view;
    this.viewCubes = new Set();
    this.cubes = null;
  }

  grid() {
    const pivot = om.multicubes
      .multicubesTab()
      .open(this.name)
      .pivot(this.view);
    return this.withoutValues(pivot).create();
  }

  /**
   * Collects cube names during Items traversal.
   * @param {string} key
   * @param {string} dimension
   */
  onItemAdded(key, dimension) {
    if (dimension === 'Cubes') this.viewCubes.add(key);
  }

  /**
   * After Items traversal: load cube properties for all cubes encountered.
   */
  afterRead() {
    if (this.viewCubes.size > 0) {
      this.cubes = this.getCubesInfo([...this.viewCubes]);
    }
  }

  /**
   * Retrieves cube properties for the specified cubes in this multicube.
   * @param {string[]} [names=[]] - Array of cube names to filter. If empty, returns all cubes.
   * @returns {Object} Cubes info object: { cubeName: { hasFormula, formula, format, summary, timeSummary } }
   */
  getCubesInfo(names = []) {
    const request = new Request({
      action: Action.GET,
      source: {
        type: DataService.SourceType.CUBES,
        name: this.name,
        filters: Object.assign(
          { "Cube Property": ["Formula", "Format", "Summary", "Time Summary"] },
          names.length > 0 ? { "Multicube With Cube": names } : {}
        )
      },
      params: {
        match: { lablesOnly: false },
        grid: { maxCells: 0 }
      }
    });

    return request.execute().cells || {};
  }

  /**
   * Loads data from the given multicube view into the environment
   * and returns it.
   * @returns {object} The data object read from environment.
   */
  getFromMulticube() {
    om.environment.loadFromMulticube(this.name, this.view);
    return om.environment.get(this.view);
  }
}

class Cubes extends DataService {
  /**
   * @param {string} type  - CUBE
   * @param {string} name  - Multicube name
   * @param {Object<string,string[]>} [filters] - Filters
   * 
   */
  constructor(type, name, filters) {
    super(type, filters);
    this.name = name;
  }

  grid() {
    const pivot = om.multicubes.multicubesTab().open(this.name).cubesTab().pivot();
    return this.applyColumnsFilter(pivot, 'Cube Property').create();
  }
}

/**
 *
 * Utility helpers for resolving whether a dimension name is a real List or a Subset
 */
class DimensionLookup {
  /**
   * Canonical Time list names.
   * @type {string[]}
   */
  static TIME_LISTS = [
    'Years',
    'Months',
    'Days',
  ];

  /**
   * Scans the model and returns a Set of ALL list names.
   *
   * @param {number} [chunkSize=5000] - Maximum row chunk size for the generator.
   * @param {number} [rowCount=5000] - Row count for grid.range().
   * @returns {Set<string>} A set of unique list names.
   */
  static getAllListNames(chunkSize = 5000, rowCount = 5000) {
    const grid = om.lists.listsTab().pivot().create();
    const generator = grid.range(0, rowCount, 0, -1).generator(chunkSize);

    const names = new Set();

    for (const chunk of generator) {
      chunk.rows().all().forEach(labelsGroup  => {
        names.add(labelsGroup.first().name());
      });
    }
    return names;
  }

  /**
   * Returns a Subset Tab handle for the given dimension/list name.
   *
   * @param {string} listName - Dimension/List name to open subsets for.
   * @returns {object} A tab object exposing .pivot().create() for subset grid.
   */
  static getDimensionSubsetTab(listName) {
    if (listName === 'Versions') {
      return om.versions.versionSubsetsTab();
    }

    if (this.TIME_LISTS.includes(listName)) {
      return om.times.timePeriodTab(listName).subsetsTab();
    }

    return om.lists.listsTab().open(listName).listSubsetTab();
  }

  /**
   * Checks whether a subset named `subsetName` exists under the given `listName`.
   *
   * @param {string} listName
   * @param {string} subsetName
   * @param {Map<string, boolean>} [cache=new Map()] - Optional cache (mutated in-place).
   * @param {number} [chunkSize=5000] - Generator chunk size for scanning.
   * @param {number} [rowCount=5000] - Row count for grid.range().
   * @returns {boolean} True if the subset exists, false otherwise.
   */
  static hasSubset(listName, subsetName, cache = new Map(), chunkSize = 5000, rowCount = 5000) {
    // Serialize the pair as a JSON tuple to avoid collisions.
    const cacheKey = JSON.stringify([listName, subsetName]);

    if (cache.has(cacheKey)) return cache.get(cacheKey);

    const tab  = this.getDimensionSubsetTab(listName);
    const grid = tab.pivot().create();
    const generator = grid.range(0, rowCount, 0, -1).generator(chunkSize);

    for (const chunk of generator) {
      for (const labelsGroup of chunk.rows().all()) {
        if (labelsGroup.first().name() === subsetName) {
          cache.set(cacheKey, true);
          return true;
        }
      }
    }

    cache.set(cacheKey, false);
    return false;
  }
}


/**
 * Entry point
 */
function main(body) {
    const response = DataService.performAction(body);
    om.common
      .apiServiceRequestInfo()
      .getResponseInfo()
      .getBodyParamInfos()
      .append('response', response);
}

// Kick off with the request’s parsed body (assumed already in env)
main(
    om.environment.get('body')
);